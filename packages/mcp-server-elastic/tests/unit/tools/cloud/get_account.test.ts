// tests/unit/tools/cloud/get_account.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerCloudGetAccountTool } from "../../../../src/tools/cloud/get_account.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

const cfg: ElasticCloudConfig = {
	apiKey: "k",
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 5000,
	maxRetries: 0,
};

function makeHandler(fetchImpl: FetchLike) {
	const server = new McpServer({ name: "t", version: "1.0.0" });
	registerCloudGetAccountTool(server, new CloudClient(cfg, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_cloud_get_account");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_cloud_get_account", () => {
	test("hits /api/v1/account and returns the JSON payload", async () => {
		let url = "";
		const handler = makeHandler(async (u) => {
			url = String(u);
			return new Response(JSON.stringify({ id: "user-1", organization_id: "org-7" }), { status: 200 });
		});
		const result = await handler({});
		expect(url).toBe("https://api.elastic-cloud.com/api/v1/account");
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { organization_id: string };
		expect(parsed.organization_id).toBe("org-7");
	});
});
