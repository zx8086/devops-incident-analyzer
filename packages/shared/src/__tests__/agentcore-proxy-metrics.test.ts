// packages/shared/src/__tests__/agentcore-proxy-metrics.test.ts
//
// SIO-1400: proxy mode bypasses the McpServer tools/call seam, so the proxy
// records tool-call counters itself. Boots startAgentCoreProxy() with a
// scratch metricsDbPath (injected via ProxyConfig; production fills it from
// MCP_TOOL_METRICS_DB_PATH in loadProxyConfigFromEnv) and asserts exactly one
// count per logical call, including across JSON-RPC retries. Reuses the
// fetch-monkey-patch harness from agentcore-proxy-roundtrip.test.ts.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentCoreProxyHandle,
	type ProxyConfig,
	type ProxyCredentials,
	startAgentCoreProxy,
} from "../agentcore-proxy.ts";
import type { IdentityCard } from "../transport/identity.ts";

const ORIG_FETCH = globalThis.fetch;

const TEST_CREDS: ProxyCredentials = {
	accessKeyId: "AKIATESTACCESSKEY123",
	secretAccessKey: "test-secret-key",
	sessionToken: "test-session-token",
};

const TEST_CARD: IdentityCard = {
	instanceId: "55555555-5555-5555-5555-555555555555",
	role: "aws-proxy",
	version: "0.0.0",
	bootedAt: "2026-05-17T00:00:00.000Z",
	pid: 1,
	mode: "agentcore-proxy",
	upstreamFingerprint: "0000000000000000",
};

interface CountRow {
	server: string;
	tool: string;
	calls: number;
	failures: number;
	bad_input_failures: number;
	unstructured_failures: number;
	unknown_tool_failures: number;
}

let dir: string;
let dbPath: string;
let proxy: AgentCoreProxyHandle;
let fetchResponder: (call: number) => Response | Promise<Response>;
let fetchCallCount: number;

function readRows(): CountRow[] {
	const db = new Database(dbPath, { readonly: true });
	const rows = db
		.query<CountRow, []>(
			"SELECT server, tool, calls, failures, bad_input_failures, unstructured_failures, unknown_tool_failures FROM mcp_tool_call_counts ORDER BY server, tool",
		)
		.all();
	db.close(false);
	return rows;
}

function countRow(tool: string, counts: Partial<Omit<CountRow, "server" | "tool">>): CountRow {
	return {
		server: "aws-mcp-server",
		tool,
		calls: 1,
		failures: 0,
		bad_input_failures: 0,
		unstructured_failures: 0,
		unknown_tool_failures: 0,
		...counts,
	};
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "proxy-metrics-"));
	dbPath = join(dir, "metrics.sqlite");
	fetchCallCount = 0;
	fetchResponder = () => new Response("not configured", { status: 500 });
	globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
		return fetchResponder(fetchCallCount++);
	}) as typeof fetch;

	const config: ProxyConfig = {
		runtimeArn: "arn:aws:bedrock:eu-central-1:123456789012:agent-runtime/test-mcp-XXXXX",
		region: "eu-central-1",
		port: 0,
		qualifier: "DEFAULT",
		serverName: "mcp-server",
		credentials: TEST_CREDS,
		metricsDbPath: dbPath,
	};
	proxy = await startAgentCoreProxy(config, TEST_CARD, "aws-proxy");
});

afterEach(async () => {
	await proxy.close();
	globalThis.fetch = ORIG_FETCH;
	rmSync(dir, { recursive: true, force: true });
});

const SSE_HEADERS = { "content-type": "text/event-stream" };

function sseFrame(jsonRpc: object): string {
	return `event: message\ndata: ${JSON.stringify(jsonRpc)}\n\n`;
}

function sseOk(id: number, text: string): Response {
	return new Response(sseFrame({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }), {
		status: 200,
		headers: SSE_HEADERS,
	});
}

function sseInnerError(id: number, text: string): Response {
	return new Response(sseFrame({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } }), {
		status: 200,
		headers: SSE_HEADERS,
	});
}

function sseJsonRpcError(id: number, code: number, message: string): Response {
	return new Response(sseFrame({ jsonrpc: "2.0", id, error: { code, message } }), {
		status: 200,
		headers: SSE_HEADERS,
	});
}

function seedResponses(...responses: (Response | Error)[]) {
	fetchResponder = (call) => {
		const r = responses[call];
		if (r === undefined) throw new Error(`fake fetch: no response seeded for call ${call}`);
		if (r instanceof Error) throw r;
		return r;
	};
}

async function callProxy(id: number, toolName: string): Promise<Response> {
	return ORIG_FETCH(`${proxy.url}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName, arguments: {} } }),
	});
}

describe("agentcore-proxy tool-call metrics", () => {
	test("a successful proxied tools/call counts one ok call", async () => {
		seedResponses(sseOk(1, "cluster healthy"));

		const response = await callProxy(1, "aws_call_aws");
		expect(response.status).toBe(200);

		expect(readRows()).toEqual([countRow("aws_call_aws", {})]);
	});

	test("an inner isError result counts one failure (prose text -> unstructured)", async () => {
		seedResponses(sseInnerError(2, "MCP error -32603: throttled"));

		const response = await callProxy(2, "aws_run_script");
		expect(response.status).toBe(200);

		expect(readRows()).toEqual([countRow("aws_run_script", { failures: 1, unstructured_failures: 1 })]);
	});

	// SIO-1402: an inner error carrying the { _error } envelope classifies with the
	// same rule as the McpServer seam (category bad-query -> bad-input).
	test("an inner envelope error classifies bad_input", async () => {
		const envelopeText = JSON.stringify({
			_error: { kind: "bad-query", category: "bad-query", message: "malformed Insights query" },
		});
		seedResponses(sseInnerError(6, envelopeText));

		const response = await callProxy(6, "aws_start_query");
		expect(response.status).toBe(200);

		expect(readRows()).toEqual([countRow("aws_start_query", { failures: 1, bad_input_failures: 1 })]);
	});

	test("a retried call counts once (retries are not separate calls)", async () => {
		// -32010 is in the retryable server-error range: attempt 1 retries, attempt 2 succeeds
		seedResponses(sseJsonRpcError(3, -32010, "runtime cold start"), sseOk(3, "recovered"));

		const response = await callProxy(3, "aws_get_tasks");
		expect(response.status).toBe(200);

		expect(fetchCallCount).toBe(2);
		expect(readRows()).toEqual([countRow("aws_get_tasks", {})]);
	});

	test("a terminal TCP failure counts one plain failure (transport, not classified)", async () => {
		seedResponses(new TypeError("fetch failed: ECONNRESET"), new TypeError("fetch failed: ECONNRESET"));

		const response = await callProxy(4, "aws_list_regions");
		expect(response.status).toBe(502);

		expect(readRows()).toEqual([countRow("aws_list_regions", { failures: 1 })]);
	});

	test("non-tools/call JSON-RPC traffic is not counted", async () => {
		seedResponses(sseOk(5, "tools listed"));

		const response = await ORIG_FETCH(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
		});
		expect(response.status).toBe(200);

		expect(readRows()).toEqual([]);
	});
});
