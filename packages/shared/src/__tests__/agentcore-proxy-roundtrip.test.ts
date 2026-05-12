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

describe("agentcore-proxy round trip — scaffold", () => {
	test("proxy starts on an ephemeral port", () => {
		expect(proxy.port).toBeGreaterThan(0);
		expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});
});
