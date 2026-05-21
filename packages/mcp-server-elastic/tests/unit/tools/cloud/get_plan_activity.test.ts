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
	test("uses ECH get_deployment endpoint with show_plans and show_plan_logs", async () => {
		let capturedUrl = "";
		const handler = makeHandler(async (u) => {
			capturedUrl = String(u);
			return new Response(
				JSON.stringify({
					resources: { elasticsearch: [{ ref_id: "main-elasticsearch", info: { plan_info: {} } }] },
				}),
				{ status: 200 },
			);
		});
		await handler({ deployment_id: "abc" });
		const url = new URL(capturedUrl);
		expect(url.pathname).toBe("/api/v1/deployments/abc");
		expect(url.searchParams.get("show_plans")).toBe("true");
		expect(url.searchParams.get("show_plan_logs")).toBe("true");
	});

	test("returns no_plan_in_progress when pending is absent", async () => {
		const handler = makeHandler(
			async () =>
				new Response(
					JSON.stringify({
						resources: { elasticsearch: [{ ref_id: "main-elasticsearch", info: { plan_info: {} } }] },
					}),
					{ status: 200 },
				),
		);
		const result = await handler({ deployment_id: "abc" });
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
			status: string;
			deployment_id: string;
			ref_id: string;
		};
		expect(parsed.status).toBe("no_plan_in_progress");
		expect(parsed.deployment_id).toBe("abc");
		expect(parsed.ref_id).toBe("main-elasticsearch");
	});

	test("returns plan_in_progress with the pending payload when a plan is running", async () => {
		const pending = {
			plan_attempt_id: "999",
			plan_attempt_log: [{ step_id: "rolling-restart", status: "in_progress" }],
		};
		const handler = makeHandler(
			async () =>
				new Response(
					JSON.stringify({
						resources: { elasticsearch: [{ ref_id: "main-elasticsearch", info: { plan_info: { pending } } }] },
					}),
					{ status: 200 },
				),
		);
		const result = await handler({ deployment_id: "abc" });
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
			status: string;
			pending: { plan_attempt_id: string };
		};
		expect(parsed.status).toBe("plan_in_progress");
		expect(parsed.pending.plan_attempt_id).toBe("999");
	});

	test("returns deployment_not_found when the deployment 404s", async () => {
		const handler = makeHandler(async () => new Response("not found", { status: 404 }));
		const result = await handler({ deployment_id: "missing" });
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { status: string; deployment_id: string };
		expect(parsed.status).toBe("deployment_not_found");
		expect(parsed.deployment_id).toBe("missing");
	});

	test("respects an explicit ref_id when multiple elasticsearch resources are present", async () => {
		const handler = makeHandler(
			async () =>
				new Response(
					JSON.stringify({
						resources: {
							elasticsearch: [
								{ ref_id: "main-elasticsearch", info: { plan_info: {} } },
								{ ref_id: "secondary-cluster", info: { plan_info: { pending: { plan_attempt_id: "42" } } } },
							],
						},
					}),
					{ status: 200 },
				),
		);
		const result = await handler({ deployment_id: "abc", ref_id: "secondary-cluster" });
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
			status: string;
			ref_id: string;
			pending: { plan_attempt_id: string };
		};
		expect(parsed.status).toBe("plan_in_progress");
		expect(parsed.ref_id).toBe("secondary-cluster");
		expect(parsed.pending.plan_attempt_id).toBe("42");
	});
});
