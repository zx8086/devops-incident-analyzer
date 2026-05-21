// tests/unit/tools/cloud/get_es_resource.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerCloudGetEsResourceTool } from "../../../../src/tools/cloud/get_es_resource.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

const cfg: ElasticCloudConfig = {
	apiKey: "k",
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 5000,
	maxRetries: 0,
};

function makeHandler(fetchImpl: FetchLike) {
	const server = new McpServer({ name: "t", version: "1.0.0" });
	registerCloudGetEsResourceTool(server, new CloudClient(cfg, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_cloud_get_es_resource");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_cloud_get_es_resource", () => {
	test("defaults ref_id to main-elasticsearch and hits the per-resource path", async () => {
		let url = "";
		const handler = makeHandler(async (u) => {
			url = String(u);
			return new Response(JSON.stringify({ ref_id: "main-elasticsearch" }), { status: 200 });
		});
		await handler({ deployment_id: "abc" });
		expect(new URL(url).pathname).toBe("/api/v1/deployments/abc/elasticsearch/main-elasticsearch");
	});

	test("forwards show_* query params", async () => {
		let url = "";
		const handler = makeHandler(async (u) => {
			url = String(u);
			return new Response("{}", { status: 200 });
		});
		await handler({
			deployment_id: "abc",
			show_plan_history: true,
			show_plan_logs: true,
			show_system_alerts: 5,
		});
		const u = new URL(url);
		expect(u.searchParams.get("show_plan_history")).toBe("true");
		expect(u.searchParams.get("show_plan_logs")).toBe("true");
		expect(u.searchParams.get("show_system_alerts")).toBe("5");
	});

	test("rejects empty deployment_id at validation", async () => {
		const handler = makeHandler(async () => new Response("{}", { status: 200 }));
		await expect(handler({ deployment_id: "" })).rejects.toBeInstanceOf(McpError);
	});
});
