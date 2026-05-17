// packages/shared/src/transport/__tests__/proxy-readiness.test.ts
import { describe, expect, test } from "bun:test";
import { createProxyReadinessProbe } from "../proxy-readiness.ts";

function mockSigv4Fetch(body: unknown, status = 200) {
	return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
			sigv4Fetch: mockSigv4Fetch({ result: { tools: [{ name: "aws___call_aws" }] } }),
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
});
