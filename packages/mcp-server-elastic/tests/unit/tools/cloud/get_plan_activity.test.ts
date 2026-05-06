// tests/unit/tools/cloud/get_plan_activity.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerCloudGetPlanActivityTool } from "../../../../src/tools/cloud/get_plan_activity.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

const cfg: ElasticCloudConfig = {
	apiKey: "k",
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 5000,
	maxRetries: 0,
};

function makeHandler(fetchImpl: FetchLike) {
	const server = new McpServer({ name: "t", version: "1.0.0" });
	registerCloudGetPlanActivityTool(server, new CloudClient(cfg, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_cloud_get_plan_activity");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_cloud_get_plan_activity", () => {
	test("defaults ref_id to main-elasticsearch", async () => {
		let url = "";
		const handler = makeHandler(async (u) => {
			url = String(u);
			return new Response(JSON.stringify({ current: { plan_attempt_log: [] } }), { status: 200 });
		});
		await handler({ deployment_id: "abc" });
		expect(url).toBe(
			"https://api.elastic-cloud.com/api/v1/deployments/abc/elasticsearch/main-elasticsearch/plan/activity",
		);
	});

	test("respects an explicit ref_id when provided", async () => {
		let url = "";
		const handler = makeHandler(async (u) => {
			url = String(u);
			return new Response("{}", { status: 200 });
		});
		await handler({ deployment_id: "abc", ref_id: "secondary-cluster" });
		expect(url).toBe(
			"https://api.elastic-cloud.com/api/v1/deployments/abc/elasticsearch/secondary-cluster/plan/activity",
		);
	});
});
