// packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
//
// SIO-737: retry behaviour for JSON-RPC -320xx server errors returned
// inside successful HTTP envelopes by the AgentCore runtime. Reuses the
// fetch-monkey-patch harness from agentcore-proxy-roundtrip.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	type AgentCoreProxyHandle,
	clearCredentialCache,
	computeJitteredBackoff,
	extractJsonRpcErrorCode,
	sleepWithAbort,
	startAgentCoreProxy,
} from "../agentcore-proxy.ts";

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
	process.env.MCP_SERVER_NAME = "mcp-server-retry-test";
});

afterAll(() => {
	process.env = ORIG_ENV;
	globalThis.fetch = ORIG_FETCH;
});

describe("extractJsonRpcErrorCode", () => {
	test("returns code for inline JSON body", () => {
		const body = `{"jsonrpc":"2.0","id":1,"error":{"code":-32010,"message":"runtime"}}`;
		expect(extractJsonRpcErrorCode(body)).toBe(-32010);
	});

	test("returns code from SSE-framed body (last data: frame)", () => {
		const body = `event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"tool"}}\n\n`;
		expect(extractJsonRpcErrorCode(body)).toBe(-32603);
	});

	test("returns undefined for successful response", () => {
		const body = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n`;
		expect(extractJsonRpcErrorCode(body)).toBeUndefined();
	});

	test("returns undefined when error object lacks numeric code", () => {
		const body = `{"jsonrpc":"2.0","id":1,"error":{"message":"broken"}}`;
		expect(extractJsonRpcErrorCode(body)).toBeUndefined();
	});

	test("returns undefined for unparseable body", () => {
		expect(extractJsonRpcErrorCode("not json")).toBeUndefined();
		expect(extractJsonRpcErrorCode("")).toBeUndefined();
	});
});

describe("computeJitteredBackoff", () => {
	test("returns base +-20% on each call", () => {
		for (let i = 0; i < 200; i++) {
			const v = computeJitteredBackoff(1000);
			expect(v).toBeGreaterThanOrEqual(800);
			expect(v).toBeLessThanOrEqual(1200);
		}
	});

	test("returns 0 when base is 0", () => {
		expect(computeJitteredBackoff(0)).toBe(0);
	});

	test("is non-deterministic across calls (best-effort)", () => {
		const samples = new Set<number>();
		for (let i = 0; i < 50; i++) samples.add(computeJitteredBackoff(1000));
		expect(samples.size).toBeGreaterThan(10);
	});
});

describe("session-scoped abort controller", () => {
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
	});

	test("DELETE clears session and resets abort controller", async () => {
		fetchResponder = () =>
			new Response(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" },
			});
		await fetch(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});

		const delRes = await fetch(`${proxy.url}/mcp`, { method: "DELETE" });
		expect(delRes.status).toBe(200);

		fetchCalls = [];
		await fetch(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }),
		});
		const sentHeaders = fetchCalls[0]?.init.headers as Record<string, string>;
		expect(sentHeaders["mcp-session-id"]).toBeUndefined();
	});
});
