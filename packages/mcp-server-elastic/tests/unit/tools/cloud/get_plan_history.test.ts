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
	test("uses get_deployment with show_plan_history=true and extracts embedded history[]", async () => {
		let capturedUrl = "";
		const handler = makeHandler(async (u) => {
			capturedUrl = String(u);
			return new Response(
				JSON.stringify({
					resources: {
						elasticsearch: [
							{
								ref_id: "main-elasticsearch",
								info: { plan_info: { history: [{ plan_attempt_id: "187" }, { plan_attempt_id: "188" }] } },
							},
						],
					},
				}),
				{ status: 200 },
			);
		});
		const result = await handler({ deployment_id: "abc" });
		const url = new URL(capturedUrl);
		expect(url.pathname).toBe("/api/v1/deployments/abc");
		expect(url.searchParams.get("show_plans")).toBe("true");
		expect(url.searchParams.get("show_plan_history")).toBe("true");
		expect(url.searchParams.get("show_plan_logs")).toBe("true");
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
			deployment_id: string;
			ref_id: string;
			history: Array<{ plan_attempt_id: string }>;
		};
		expect(parsed.deployment_id).toBe("abc");
		expect(parsed.ref_id).toBe("main-elasticsearch");
		expect(parsed.history).toHaveLength(2);
		expect(parsed.history[0]?.plan_attempt_id).toBe("187");
	});

	test("forwards force_all_plan_history when provided", async () => {
		let capturedUrl = "";
		const handler = makeHandler(async (u) => {
			capturedUrl = String(u);
			return new Response(JSON.stringify({ resources: { elasticsearch: [] } }), { status: 200 });
		});
		await handler({ deployment_id: "abc", force_all_plan_history: true });
		const url = new URL(capturedUrl);
		expect(url.searchParams.get("force_all_plan_history")).toBe("true");
	});

	test("returns an empty history[] when no elasticsearch resources are present", async () => {
		const handler = makeHandler(
			async () => new Response(JSON.stringify({ resources: { elasticsearch: [] } }), { status: 200 }),
		);
		const result = await handler({ deployment_id: "abc" });
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { history: unknown[] };
		expect(parsed.history).toEqual([]);
	});

	test("picks the matching ref_id when the deployment has multiple elasticsearch resources", async () => {
		const handler = makeHandler(
			async () =>
				new Response(
					JSON.stringify({
						resources: {
							elasticsearch: [
								{ ref_id: "main-elasticsearch", info: { plan_info: { history: [] } } },
								{ ref_id: "secondary-cluster", info: { plan_info: { history: [{ plan_attempt_id: "55" }] } } },
							],
						},
					}),
					{ status: 200 },
				),
		);
		const result = await handler({ deployment_id: "abc", ref_id: "secondary-cluster" });
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
			ref_id: string;
			history: Array<{ plan_attempt_id: string }>;
		};
		expect(parsed.ref_id).toBe("secondary-cluster");
		expect(parsed.history[0]?.plan_attempt_id).toBe("55");
	});
});
