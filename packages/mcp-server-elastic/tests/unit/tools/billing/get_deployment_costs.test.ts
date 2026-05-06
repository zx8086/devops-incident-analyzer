// tests/unit/tools/billing/get_deployment_costs.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerBillingGetDeploymentCostsTool } from "../../../../src/tools/billing/get_deployment_costs.js";
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
	registerBillingGetDeploymentCostsTool(server, new CloudClient(full, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_billing_get_deployment_costs");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_billing_get_deployment_costs", () => {
	test("builds the per-deployment URL using default org and explicit deployment", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-1" }, async (u) => {
			url = String(u);
			return new Response("{}", { status: 200 });
		});
		await handler({ deployment_id: "dep-abc" });
		expect(new URL(url).pathname).toBe("/api/v1/billing/costs/organizations/org-1/deployments/dep-abc/items");
	});

	test("rejects empty deployment_id", async () => {
		const handler = makeHandler({ defaultOrgId: "org-1" }, async () => new Response("{}", { status: 200 }));
		await expect(handler({ deployment_id: "" })).rejects.toBeInstanceOf(McpError);
	});

	test("rejects when no org_id resolvable", async () => {
		const handler = makeHandler({}, async () => new Response("{}", { status: 200 }));
		await expect(handler({ deployment_id: "dep-abc" })).rejects.toBeInstanceOf(McpError);
	});
});
