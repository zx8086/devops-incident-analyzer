// tests/unit/tools/billing/get_instance_items.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerBillingGetInstanceItemsTool } from "../../../../src/tools/billing/get_instance_items.js";
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
	registerBillingGetInstanceItemsTool(server, new CloudClient(full, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_billing_get_instance_items");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_billing_get_instance_items", () => {
	test("hits the per-instance items v2 path", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-1" }, async (u) => {
			url = String(u);
			return new Response(JSON.stringify({ products: [] }), { status: 200 });
		});
		await handler({ instance_id: "deploy-7", from: "2026-04-01", to: "2026-05-01" });
		const u = new URL(url);
		expect(u.pathname).toBe("/api/v2/billing/organizations/org-1/costs/instances/deploy-7/items");
	});

	test("rejects empty instance_id", async () => {
		const handler = makeHandler({ defaultOrgId: "org-1" }, async () => new Response("{}", { status: 200 }));
		await expect(handler({ instance_id: "", from: "a", to: "b" })).rejects.toBeInstanceOf(McpError);
	});

	test("explicit org_id overrides the default", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-default" }, async (u) => {
			url = String(u);
			return new Response("{}", { status: 200 });
		});
		await handler({ org_id: "org-override", instance_id: "i", from: "a", to: "b" });
		expect(new URL(url).pathname).toBe("/api/v2/billing/organizations/org-override/costs/instances/i/items");
	});
});
