// packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
//
// SIO-733: end-to-end round-trip coverage for the AgentCore SigV4 proxy.
// Spins up startAgentCoreProxy() on an ephemeral port, intercepts the
// outbound fetch with a programmable fake, and asserts on signed headers,
// session-id propagation, retry behaviour, and response pass-through.
// Companion to the SIO-718 inner-status unit tests in
// ./agentcore-proxy-tool-status.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type AgentCoreProxyHandle, clearCredentialCache, startAgentCoreProxy } from "../agentcore-proxy.ts";

const ORIG_ENV = { ...process.env };
const ORIG_FETCH = globalThis.fetch;

const TEST_ARN = "arn:aws:bedrock:eu-central-1:123456789012:agent-runtime/test-mcp-XXXXX";
const TEST_REGION = "eu-central-1";

beforeAll(() => {
	process.env.AGENTCORE_RUNTIME_ARN = TEST_ARN;
	process.env.AGENTCORE_REGION = TEST_REGION;
	process.env.AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATESTACCESSKEY123";
	process.env.AGENTCORE_AWS_SECRET_ACCESS_KEY = "test-secret-key";
	process.env.AGENTCORE_AWS_SESSION_TOKEN = "test-session-token";
	process.env.AGENTCORE_PROXY_PORT = "0";
	process.env.MCP_SERVER_NAME = "mcp-server-roundtrip-test";
});

afterAll(() => {
	process.env = ORIG_ENV;
	globalThis.fetch = ORIG_FETCH;
});

let proxy: AgentCoreProxyHandle;
let fetchCalls: { url: string; init: RequestInit }[];
let fetchResponder: (call: number) => Response | Promise<Response>;

beforeEach(async () => {
	fetchCalls = [];
	fetchResponder = () => new Response("not configured", { status: 500 });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const callIdx = fetchCalls.length;
		fetchCalls.push({ url: String(input), init: init ?? {} });
		return fetchResponder(callIdx);
	}) as typeof fetch;
	clearCredentialCache();
	proxy = await startAgentCoreProxy();
});

afterEach(async () => {
	await proxy.close();
	globalThis.fetch = ORIG_FETCH;
});

const SSE_HEADERS = { "content-type": "text/event-stream" };
const JSON_HEADERS = { "content-type": "application/json" };

function sseFrame(jsonRpc: object): string {
	return `event: message\ndata: ${JSON.stringify(jsonRpc)}\n\n`;
}

function sseOk(id: number, result: unknown, extra: HeadersInit = {}): Response {
	return new Response(sseFrame({ jsonrpc: "2.0", id, result }), { status: 200, headers: { ...SSE_HEADERS, ...extra } });
}

// biome-ignore lint/correctness/noUnusedVariables: SIO-733 - used by Tasks 5-6 (error-path tests)
function sseInnerError(id: number, text: string, extra: HeadersInit = {}): Response {
	return new Response(
		sseFrame({
			jsonrpc: "2.0",
			id,
			result: { isError: true, content: [{ type: "text", text }] },
		}),
		{ status: 200, headers: { ...SSE_HEADERS, ...extra } },
	);
}

// biome-ignore lint/correctness/noUnusedVariables: SIO-733 - used by Tasks 5-6 (error-path tests)
function jsonRpcErrorResponse(id: number, code: number, message: string): Response {
	return new Response(sseFrame({ jsonrpc: "2.0", id, error: { code, message } }), {
		status: 200,
		headers: SSE_HEADERS,
	});
}

function toolCall(id: number, name: string, args: object = {}): object {
	return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function seedResponses(...responses: (Response | Error)[]) {
	fetchResponder = (call) => {
		const r = responses[call];
		if (r === undefined) {
			throw new Error(`fake fetch: no response seeded for call ${call} (seeded ${responses.length})`);
		}
		if (r instanceof Error) throw r;
		return r;
	};
}

// Uses ORIG_FETCH, not globalThis.fetch: the swapped fake is for outbound
// calls FROM the proxy; the inbound test client must not get intercepted.
async function callProxy(jsonRpcPayload: object) {
	const response = await ORIG_FETCH(`${proxy.url}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(jsonRpcPayload),
	});
	return { response, body: await response.text() };
}

const SIGV4_AUTH_RE =
	/^AWS4-HMAC-SHA256 Credential=AKIA[A-Z0-9]+\/\d{8}\/eu-central-1\/bedrock-agentcore\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}$/;
const AMZ_DATE_RE = /^\d{8}T\d{6}Z$/;

function assertSigV4(call: { url: string; init: RequestInit }) {
	const expectedUrl =
		`https://bedrock-agentcore.${TEST_REGION}.amazonaws.com` +
		`/runtimes/${encodeURIComponent(TEST_ARN)}/invocations?qualifier=DEFAULT`;
	expect(call.url).toBe(expectedUrl);

	const headers = call.init.headers as Record<string, string>;
	const authMatch = headers.authorization?.match(SIGV4_AUTH_RE);
	expect(authMatch).not.toBeNull();

	const signedHeaders = authMatch?.[1]?.split(";") ?? [];
	expect(signedHeaders).toEqual(
		expect.arrayContaining(["accept", "content-type", "host", "x-amz-date", "x-amz-security-token"]),
	);

	expect(headers["x-amz-date"]).toMatch(AMZ_DATE_RE);
	expect(headers["x-amz-security-token"]).toBe("test-session-token");
	expect(headers["content-type"]).toBe("application/json");
	expect(headers.accept).toBe("application/json, text/event-stream");
	expect(headers.host).toBe(`bedrock-agentcore.${TEST_REGION}.amazonaws.com`);
}

describe("agentcore-proxy round trip — happy paths", () => {
	test("200 + SSE-framed result passes through with SigV4 well-formed", async () => {
		seedResponses(sseOk(1, { content: [{ type: "text", text: "version=7.2.1" }] }));

		const { response, body } = await callProxy(toolCall(1, "kafka_get_cluster_info"));

		expect(response.status).toBe(200);
		expect(body).toContain("version=7.2.1");
		expect(fetchCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: SIO-733 - length asserted above
		assertSigV4(fetchCalls[0]!);
	});

	test("200 + raw JSON (no SSE framing) preserves content-type", async () => {
		const rawBody = JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		seedResponses(new Response(rawBody, { status: 200, headers: JSON_HEADERS }));

		const { response, body } = await callProxy(toolCall(2, "noop"));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(body).toBe(rawBody);
		expect(fetchCalls).toHaveLength(1);
	});

	test("mcp-session-id is captured from upstream and replayed on subsequent calls", async () => {
		seedResponses(
			sseOk(3, { content: [{ type: "text", text: "first" }] }, { "mcp-session-id": "sess-abc-123" }),
			sseOk(4, { content: [{ type: "text", text: "second" }] }),
		);

		const r1 = await callProxy(toolCall(3, "step1"));
		const r2 = await callProxy(toolCall(4, "step2"));

		expect(r1.response.status).toBe(200);
		expect(r2.response.status).toBe(200);
		expect(fetchCalls).toHaveLength(2);

		// biome-ignore lint/style/noNonNullAssertion: SIO-733 - length asserted above
		const call1Headers = fetchCalls[0]!.init.headers as Record<string, string>;
		// biome-ignore lint/style/noNonNullAssertion: SIO-733 - length asserted above
		const call2Headers = fetchCalls[1]!.init.headers as Record<string, string>;

		expect(call1Headers["mcp-session-id"]).toBeUndefined();
		expect(call2Headers["mcp-session-id"]).toBe("sess-abc-123");
	});

	test("omits x-amz-security-token when sessionToken is unset", async () => {
		const savedToken = process.env.AGENTCORE_AWS_SESSION_TOKEN;
		await proxy.close();
		try {
			delete process.env.AGENTCORE_AWS_SESSION_TOKEN;
			clearCredentialCache();
			proxy = await startAgentCoreProxy();

			seedResponses(sseOk(5, { content: [{ type: "text", text: "ok" }] }));
			await callProxy(toolCall(5, "noop"));

			expect(fetchCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: SIO-733 - length asserted above
			const headers = fetchCalls[0]!.init.headers as Record<string, string>;
			expect(headers["x-amz-security-token"]).toBeUndefined();

			const signedHeaders = headers.authorization?.match(SIGV4_AUTH_RE)?.[1]?.split(";") ?? [];
			expect(signedHeaders).not.toContain("x-amz-security-token");
		} finally {
			if (savedToken) process.env.AGENTCORE_AWS_SESSION_TOKEN = savedToken;
		}
	});
});
