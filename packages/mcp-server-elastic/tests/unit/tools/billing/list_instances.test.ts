// tests/unit/tools/billing/list_instances.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerBillingListInstancesTool } from "../../../../src/tools/billing/list_instances.js";
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
	registerBillingListInstancesTool(server, new CloudClient(full, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_billing_list_instances");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_billing_list_instances", () => {
	test("uses EC_DEFAULT_ORG_ID when org_id is omitted", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-default" }, async (u) => {
			url = String(u);
			return new Response(JSON.stringify({ instances: [] }), { status: 200 });
		});
		await handler({ from: "2026-04-01", to: "2026-05-01", include_names: true });
		const u = new URL(url);
		expect(u.pathname).toBe("/api/v2/billing/organizations/org-default/costs/instances");
		expect(u.searchParams.get("from")).toBe("2026-04-01");
		expect(u.searchParams.get("to")).toBe("2026-05-01");
		expect(u.searchParams.get("include_names")).toBe("true");
	});

	test("rejects when neither org_id arg nor EC_DEFAULT_ORG_ID is set", async () => {
		const handler = makeHandler({}, async () => new Response("{}", { status: 200 }));
		await expect(handler({ from: "2026-04-01", to: "2026-05-01" })).rejects.toBeInstanceOf(McpError);
	});

	test("rejects when from/to are missing", async () => {
		const handler = makeHandler({ defaultOrgId: "org-1" }, async () => new Response("{}", { status: 200 }));
		await expect(handler({})).rejects.toBeInstanceOf(McpError);
	});
});
