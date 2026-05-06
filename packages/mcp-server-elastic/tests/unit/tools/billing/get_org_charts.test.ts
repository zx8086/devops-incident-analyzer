// tests/unit/tools/billing/get_org_charts.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerBillingGetOrgChartsTool } from "../../../../src/tools/billing/get_org_charts.js";
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
	registerBillingGetOrgChartsTool(server, new CloudClient(full, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_billing_get_org_charts");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_billing_get_org_charts", () => {
	test("forwards bucketing_strategy as a query param", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-1" }, async (u) => {
			url = String(u);
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		});
		await handler({ bucketing_strategy: "daily", from: "2026-04-01", to: "2026-05-01" });
		const u = new URL(url);
		expect(u.pathname).toBe("/api/v1/billing/costs/organizations/org-1/charts");
		expect(u.searchParams.get("bucketing_strategy")).toBe("daily");
		expect(u.searchParams.get("from")).toBe("2026-04-01");
		expect(u.searchParams.get("to")).toBe("2026-05-01");
	});

	test("rejects an unsupported bucketing_strategy at the schema level", async () => {
		const handler = makeHandler({ defaultOrgId: "org-1" }, async () => new Response("{}", { status: 200 }));
		await expect(handler({ bucketing_strategy: "yearly" })).rejects.toBeInstanceOf(McpError);
	});
});
