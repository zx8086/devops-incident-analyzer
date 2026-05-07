// tests/unit/tools/billing/get_org_costs.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerBillingGetOrgCostsTool } from "../../../../src/tools/billing/get_org_costs.js";
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
	registerBillingGetOrgCostsTool(server, new CloudClient(full, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_billing_get_org_costs");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_billing_get_org_costs", () => {
	test("uses EC_DEFAULT_ORG_ID when org_id is not provided (SIO-678: v2 path)", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-default" }, async (u) => {
			url = String(u);
			return new Response(JSON.stringify({ total_ecu: 0, products: [] }), { status: 200 });
		});
		await handler({ from: "2026-04-01T00:00:00Z", to: "2026-05-01T00:00:00Z" });
		const u = new URL(url);
		expect(u.pathname).toBe("/api/v2/billing/organizations/org-default/costs/items");
		expect(u.searchParams.get("from")).toBe("2026-04-01T00:00:00Z");
		expect(u.searchParams.get("to")).toBe("2026-05-01T00:00:00Z");
	});

	test("explicit org_id overrides the default", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-default" }, async (u) => {
			url = String(u);
			return new Response("{}", { status: 200 });
		});
		await handler({ org_id: "org-override", from: "2026-04-01", to: "2026-05-01" });
		expect(new URL(url).pathname).toBe("/api/v2/billing/organizations/org-override/costs/items");
	});

	test("rejects when neither org_id arg nor EC_DEFAULT_ORG_ID is set", async () => {
		const handler = makeHandler({}, async () => new Response("{}", { status: 200 }));
		await expect(handler({ from: "2026-04-01", to: "2026-05-01" })).rejects.toBeInstanceOf(McpError);
	});

	test("rejects when from/to are missing (SIO-678: v2 API requires them)", async () => {
		const handler = makeHandler({ defaultOrgId: "org-1" }, async () => new Response("{}", { status: 200 }));
		await expect(handler({})).rejects.toBeInstanceOf(McpError);
		await expect(handler({ from: "2026-04-01" })).rejects.toBeInstanceOf(McpError);
		await expect(handler({ to: "2026-05-01" })).rejects.toBeInstanceOf(McpError);
	});
});
