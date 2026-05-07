// tests/unit/tools/cloud/get_plan_history.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerCloudGetPlanHistoryTool } from "../../../../src/tools/cloud/get_plan_history.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

const cfg: ElasticCloudConfig = {
	apiKey: "k",
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 5000,
	maxRetries: 0,
};

function makeHandler(fetchImpl: FetchLike) {
	const server = new McpServer({ name: "t", version: "1.0.0" });
	registerCloudGetPlanHistoryTool(server, new CloudClient(cfg, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_cloud_get_plan_history");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_cloud_get_plan_history", () => {
	test("defaults ref_id to main-elasticsearch and hits plan/history path", async () => {
		let url = "";
		const handler = makeHandler(async (u) => {
			url = String(u);
			return new Response(JSON.stringify({ history: [{ plan_attempt_id: "187" }] }), { status: 200 });
		});
		const result = await handler({ deployment_id: "abc" });
		expect(url).toContain("/elasticsearch/main-elasticsearch/plan/history");
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { history: Array<{ plan_attempt_id: string }> };
		expect(parsed.history[0]?.plan_attempt_id).toBe("187");
	});
});
