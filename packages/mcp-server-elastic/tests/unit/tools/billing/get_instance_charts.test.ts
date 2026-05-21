// tests/unit/tools/billing/get_instance_charts.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerBillingGetInstanceChartsTool } from "../../../../src/tools/billing/get_instance_charts.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

function makeHandler(cfg: Partial<ElasticCloudConfig>, fetchImpl: FetchLike) {
	const full: ElasticCloudConfig = {
		apiKey: "k",
		endpoint: "https://api.elastic-cloud.com",
		requestTimeout: 5000,
		maxRetries: 0,
		...cfg,
	};
	const server = new McpServer({ name: "t", version: "1.0.0" });
	registerBillingGetInstanceChartsTool(server, new CloudClient(full, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_billing_get_instance_charts");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_billing_get_instance_charts", () => {
	test("hits the per-instance charts v2 path with bucketing_strategy", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-1" }, async (u) => {
			url = String(u);
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		});
		await handler({
			instance_id: "deploy-7",
			from: "2026-04-01",
			to: "2026-05-01",
			bucketing_strategy: "daily",
			instance_type: "deployments",
		});
		const u = new URL(url);
		expect(u.pathname).toBe("/api/v2/billing/organizations/org-1/instances/deploy-7/charts");
		expect(u.searchParams.get("bucketing_strategy")).toBe("daily");
		expect(u.searchParams.get("instance_type")).toBe("deployments");
	});

	test("rejects invalid bucketing_strategy", async () => {
		const handler = makeHandler({ defaultOrgId: "org-1" }, async () => new Response("{}", { status: 200 }));
		await expect(
			handler({ instance_id: "i", from: "a", to: "b", bucketing_strategy: "hourly" }),
		).rejects.toBeInstanceOf(McpError);
	});

	test("rejects when neither org_id arg nor EC_DEFAULT_ORG_ID is set", async () => {
		const handler = makeHandler({}, async () => new Response("{}", { status: 200 }));
		await expect(handler({ instance_id: "i", from: "a", to: "b" })).rejects.toBeInstanceOf(McpError);
	});
});
