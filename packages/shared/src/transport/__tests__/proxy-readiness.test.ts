// packages/shared/src/transport/__tests__/proxy-readiness.test.ts
import { describe, expect, test } from "bun:test";
import { createProxyReadinessProbe } from "../proxy-readiness.ts";

function mockSigv4Fetch(body: unknown, status = 200) {
	return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// SIO-780: AgentCore's streamable-HTTP MCP transport returns SSE-framed JSON-RPC
// when the upstream is warm. Body is "event: message\ndata: <json>\n\n".
function mockSseSigv4Fetch(jsonBody: unknown, status = 200) {
	const sse = `event: message\ndata: ${JSON.stringify(jsonBody)}\n\n`;
	return async () => new Response(sse, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("createProxyReadinessProbe", () => {
	test("credentials + sentinel tool present -> ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "kafka_list_topics" }] } }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components).toEqual({ credentials: "ok", agentcoreUpstream: "ok" });
	});

	test("credentials fail -> not ready, agentcoreUpstream still probed", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => {
				throw new Error("expired creds");
			},
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "aws_cloudwatch_describe_alarms" }] } }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.credentials).toBe("unreachable");
		expect(snap.errors?.credentials).toBe("expired creds");
	});

	test("upstream returns wrong sentinel -> not ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "elastic_search" }] } }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.agentcoreUpstream).toBe("unreachable");
		expect(snap.errors?.agentcoreUpstream).toContain("kafka_list_topics");
	});

	test("upstream returns 503 -> not ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({}, 503),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.agentcoreUpstream).toBe("unreachable");
		expect(snap.errors?.agentcoreUpstream).toContain("503");
	});

	test("empty tools list -> not ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [] } }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.agentcoreUpstream).toBe("unreachable");
	});

	// SIO-780 follow-up: AgentCore returns Content-Type: text/event-stream with
	// "event: message\ndata: <json>" framing once the runtime is warm. The original
	// probe called res.json() and threw "Failed to parse JSON", masking healthy
	// upstreams as unready in production.
	test("SSE-framed success body -> ready", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSseSigv4Fetch({ result: { tools: [{ name: "kafka_list_topics" }] }, jsonrpc: "2.0", id: 1 }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components.agentcoreUpstream).toBe("ok");
	});

	test("SSE-framed wrong sentinel -> not ready with sentinel error", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSseSigv4Fetch({ result: { tools: [{ name: "kafka_list_topics" }] }, jsonrpc: "2.0", id: 1 }),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.errors?.agentcoreUpstream).toContain("aws_cloudwatch_describe_alarms");
	});

	// AgentCore returns this JSON-RPC envelope (Content-Type: application/json,
	// HTTP 200) while the runtime is cold-starting. The pre-fix probe parsed it
	// successfully, then mis-reported "expected sentinel tool ... 0 tools" because
	// the sentinel check ran on an error response. Detect -32010 explicitly so the
	// operator sees the actual failure mode.
	test("cold-start -32010 -> not ready with cold-start error", async () => {
		const probe = createProxyReadinessProbe({
			role: "kafka-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({
				jsonrpc: "2.0",
				error: { code: -32010, message: "Runtime health check failed or timed out." },
				id: 1,
			}),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.agentcoreUpstream).toBe("unreachable");
		expect(snap.errors?.agentcoreUpstream).toContain("cold-start");
		expect(snap.errors?.agentcoreUpstream).toContain("-32010");
	});

	// Real AWS MCP server registers per-service tools (e.g. aws_cloudwatch_describe_alarms);
	// it does NOT expose a generic dispatcher. The sentinel must match a tool that's
	// always registered. cloudwatch_describe_alarms is the agent's primary triage entry
	// per agents/incident-analyzer/agents/aws-agent/RULES.md.
	test("aws-proxy sentinel is aws_cloudwatch_describe_alarms (single underscore)", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSigv4Fetch({
				result: {
					tools: [
						{ name: "aws_cloudformation_list_stacks" },
						{ name: "aws_cloudwatch_describe_alarms" },
						{ name: "aws_ec2_describe_instances" },
					],
				},
			}),
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components.agentcoreUpstream).toBe("ok");
	});

	test("SSE-framed -32010 -> not ready with cold-start error", async () => {
		const probe = createProxyReadinessProbe({
			role: "aws-proxy",
			getCredentials: async () => ({}),
			upstreamUrl: "http://example.test/mcp",
			sigv4Fetch: mockSseSigv4Fetch({
				jsonrpc: "2.0",
				error: { code: -32010, message: "Runtime health check failed or timed out." },
				id: 1,
			}),
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.errors?.agentcoreUpstream).toContain("cold-start");
	});
});
