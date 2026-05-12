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

describe("sleepWithAbort", () => {
	test("resolves after the requested delay when not aborted", async () => {
		const t0 = Date.now();
		await sleepWithAbort(40, new AbortController().signal);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
	});

	test("rejects immediately when signal already aborted", async () => {
		const ac = new AbortController();
		ac.abort(new Error("preempted"));
		await expect(sleepWithAbort(1000, ac.signal)).rejects.toThrow("preempted");
	});

	test("rejects mid-sleep when signal aborts", async () => {
		const ac = new AbortController();
		const t0 = Date.now();
		const sleepPromise = sleepWithAbort(5000, ac.signal);
		setTimeout(() => ac.abort(new Error("midflight")), 20);
		await expect(sleepPromise).rejects.toThrow("midflight");
		expect(Date.now() - t0).toBeLessThan(200);
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
		await ORIG_FETCH(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});

		const delRes = await ORIG_FETCH(`${proxy.url}/mcp`, { method: "DELETE" });
		expect(delRes.status).toBe(200);

		fetchCalls = [];
		await ORIG_FETCH(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }),
		});
		const sentHeaders = fetchCalls[0]?.init.headers as Record<string, string>;
		expect(sentHeaders["mcp-session-id"]).toBeUndefined();
	});
});

describe("JSON-RPC -320xx retry", () => {
	let proxy: AgentCoreProxyHandle;
	let fetchCalls: { url: string; init: RequestInit }[];
	let scriptedResponses: Array<Response | (() => Response | Promise<Response>)>;

	beforeEach(async () => {
		fetchCalls = [];
		scriptedResponses = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const idx = fetchCalls.length;
			fetchCalls.push({ url: String(input), init: init ?? {} });
			const entry = scriptedResponses[idx];
			if (!entry) return new Response("scripted-exhausted", { status: 500 });
			return typeof entry === "function" ? entry() : entry.clone();
		}) as typeof fetch;
		clearCredentialCache();
		proxy = await startAgentCoreProxy();
	});

	afterEach(async () => {
		await proxy.close();
	});

	function jsonRpcError(code: number, id = 1): Response {
		return new Response(
			`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: `code ${code}` } })}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "session-x" } },
		);
	}

	function jsonRpcOk(id = 1): Response {
		return new Response(
			`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "session-x" } },
		);
	}

	async function callTool(name = "kafka_get_cluster_info", id = 1): Promise<Response> {
		return ORIG_FETCH(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }),
		});
	}

	test("retries -32010 and recovers on attempt 3", async () => {
		scriptedResponses = [jsonRpcError(-32010), jsonRpcError(-32010), jsonRpcOk()];
		const res = await callTool();
		const body = await res.text();
		expect(res.status).toBe(200);
		expect(body).toContain('"result"');
		expect(fetchCalls.length).toBe(3);
	});

	test("retries -32011 and recovers", async () => {
		scriptedResponses = [jsonRpcError(-32011), jsonRpcOk()];
		const res = await callTool();
		expect(res.status).toBe(200);
		expect(fetchCalls.length).toBe(2);
	});

	test("retries -32099 (lower band edge) and recovers", async () => {
		scriptedResponses = [jsonRpcError(-32099), jsonRpcOk()];
		const res = await callTool();
		expect(res.status).toBe(200);
		expect(fetchCalls.length).toBe(2);
	});

	test("does NOT retry -32603 (tool error)", async () => {
		scriptedResponses = [jsonRpcError(-32603), jsonRpcOk()];
		const res = await callTool();
		const body = await res.text();
		expect(body).toContain('"code":-32603');
		expect(fetchCalls.length).toBe(1);
	});

	test("does NOT retry -32602 (invalid params)", async () => {
		scriptedResponses = [jsonRpcError(-32602), jsonRpcOk()];
		const res = await callTool();
		const body = await res.text();
		expect(body).toContain('"code":-32602');
		expect(fetchCalls.length).toBe(1);
	});

	test("does NOT retry plain ok response", async () => {
		scriptedResponses = [jsonRpcOk()];
		const res = await callTool();
		expect(res.status).toBe(200);
		expect(fetchCalls.length).toBe(1);
	});

	test("gives up after 5 attempts on persistent -32010", async () => {
		scriptedResponses = [
			jsonRpcError(-32010),
			jsonRpcError(-32010),
			jsonRpcError(-32010),
			jsonRpcError(-32010),
			jsonRpcError(-32010),
		];
		const res = await callTool();
		const body = await res.text();
		expect(body).toContain('"code":-32010');
		expect(fetchCalls.length).toBe(5);
	}, 15_000); // backoff budget is 5.6s worst-case with jitter; bun's 5s default is too tight

	test("preserves mcp-session-id across retried attempts", async () => {
		scriptedResponses = [jsonRpcOk()];
		await ORIG_FETCH(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		fetchCalls = [];
		scriptedResponses = [jsonRpcError(-32010), jsonRpcOk()];
		await callTool();
		const h0 = fetchCalls[0]?.init.headers as Record<string, string>;
		const h1 = fetchCalls[1]?.init.headers as Record<string, string>;
		expect(h0?.["mcp-session-id"]).toBe("session-x");
		expect(h1?.["mcp-session-id"]).toBe("session-x");
	});

	test("DELETE aborts in-flight retry sleep", async () => {
		scriptedResponses = [jsonRpcError(-32010), jsonRpcOk()];
		const callPromise = callTool();
		await new Promise((r) => setTimeout(r, 80));
		await ORIG_FETCH(`${proxy.url}/mcp`, { method: "DELETE" });

		const res = await callPromise;
		const body = await res.text();
		expect(res.status).toBe(502);
		expect(body).toContain("Session reset during retry");
		expect(fetchCalls.length).toBe(1);
	});

	test("parallel calls de-sync via independent jitter", async () => {
		const N = 5;
		const fetchTimestamps: number[] = [];
		let upstreamHits = 0;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			fetchTimestamps.push(Date.now());
			fetchCalls.push({ url: String(input), init: init ?? {} });
			upstreamHits++;
			if (upstreamHits <= N) return jsonRpcError(-32010, upstreamHits);
			return jsonRpcOk(upstreamHits);
		}) as typeof fetch;

		const promises = Array.from({ length: N }, (_, i) => callTool("kafka_get_cluster_info", 100 + i));
		const responses = await Promise.all(promises);

		for (const r of responses) expect(r.status).toBe(200);
		const retryStamps = fetchTimestamps.slice(N).sort((a, b) => a - b);
		expect(retryStamps.length).toBe(N);
		const spread = (retryStamps[N - 1] ?? 0) - (retryStamps[0] ?? 0);
		expect(spread).toBeGreaterThan(20);
	});

	test("TCP-error retry coexists with JSON-RPC retry", async () => {
		let call = 0;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			call++;
			fetchCalls.push({ url: String(input), init: init ?? {} });
			if (call === 1) {
				throw new TypeError("fetch failed: ECONNRESET");
			}
			return jsonRpcOk();
		}) as typeof fetch;

		const res = await callTool();
		expect(res.status).toBe(200);
		expect(call).toBe(2);
	});
});
