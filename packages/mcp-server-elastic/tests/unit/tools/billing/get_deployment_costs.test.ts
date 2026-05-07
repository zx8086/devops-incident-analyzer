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

const sampleChartsBody = {
	data: [
		{
			timestamp: 1775574662,
			values: [
				{ id: "dep-eu-b2b", name: "eu-b2b", type: "deployment", value: 100.5 },
				{ id: "dep-us-cld", name: "us-cld", type: "deployment", value: 267.5 },
				{ id: "dep-ap-cld", name: "ap-cld", type: "deployment", value: 50.25 },
			],
		},
		{
			timestamp: 1775661062,
			values: [
				{ id: "dep-eu-b2b", name: "eu-b2b", type: "deployment", value: 110.0 },
				{ id: "dep-us-cld", name: "us-cld", type: "deployment", value: 270.0 },
			],
		},
	],
};

describe("elasticsearch_billing_get_deployment_costs (SIO-678: charts-endpoint-derived)", () => {
	test("calls the v2 charts endpoint, not a per-deployment items path", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-1" }, async (u) => {
			url = String(u);
			return new Response(JSON.stringify(sampleChartsBody), { status: 200 });
		});
		await handler({ deployment_id: "dep-eu-b2b", from: "2026-04-01", to: "2026-05-01" });
		const parsed = new URL(url);
		expect(parsed.pathname).toBe("/api/v2/billing/organizations/org-1/charts");
		// bucketing_strategy defaults to monthly when not provided
		expect(parsed.searchParams.get("bucketing_strategy")).toBe("monthly");
		expect(parsed.searchParams.get("from")).toBe("2026-04-01");
		expect(parsed.searchParams.get("to")).toBe("2026-05-01");
	});

	test("filters chart values to the requested deployment_id and sums total_ecu", async () => {
		const handler = makeHandler(
			{ defaultOrgId: "org-1" },
			async () => new Response(JSON.stringify(sampleChartsBody), { status: 200 }),
		);
		const out = await handler({ deployment_id: "dep-eu-b2b", from: "2026-04-01", to: "2026-05-01" });
		const body = JSON.parse(out.content[0]?.text ?? "{}");
		expect(body.deployment_id).toBe("dep-eu-b2b");
		expect(body.deployment_name).toBe("eu-b2b");
		expect(body.total_ecu).toBeCloseTo(210.5, 5);
		expect(body.data.length).toBe(2);
		expect(body.data[0].values.length).toBe(1);
		expect(body.data[0].values[0].id).toBe("dep-eu-b2b");
	});

	test("accepts deployment_name as an alternative to deployment_id", async () => {
		const handler = makeHandler(
			{ defaultOrgId: "org-1" },
			async () => new Response(JSON.stringify(sampleChartsBody), { status: 200 }),
		);
		const out = await handler({ deployment_name: "us-cld", from: "2026-04-01", to: "2026-05-01" });
		const body = JSON.parse(out.content[0]?.text ?? "{}");
		expect(body.deployment_id).toBe("dep-us-cld");
		expect(body.total_ecu).toBeCloseTo(537.5, 5);
	});

	test("forwards an explicit bucketing_strategy", async () => {
		let url = "";
		const handler = makeHandler({ defaultOrgId: "org-1" }, async (u) => {
			url = String(u);
			return new Response(JSON.stringify(sampleChartsBody), { status: 200 });
		});
		await handler({
			deployment_id: "dep-eu-b2b",
			bucketing_strategy: "daily",
			from: "2026-04-01",
			to: "2026-05-01",
		});
		expect(new URL(url).searchParams.get("bucketing_strategy")).toBe("daily");
	});

	test("rejects when neither deployment_id nor deployment_name is provided", async () => {
		const handler = makeHandler(
			{ defaultOrgId: "org-1" },
			async () => new Response(JSON.stringify(sampleChartsBody), { status: 200 }),
		);
		await expect(handler({ from: "2026-04-01", to: "2026-05-01" })).rejects.toBeInstanceOf(McpError);
	});

	test("rejects empty deployment_id", async () => {
		const handler = makeHandler(
			{ defaultOrgId: "org-1" },
			async () => new Response(JSON.stringify(sampleChartsBody), { status: 200 }),
		);
		await expect(handler({ deployment_id: "", from: "2026-04-01", to: "2026-05-01" })).rejects.toBeInstanceOf(McpError);
	});

	test("rejects when no org_id resolvable", async () => {
		const handler = makeHandler({}, async () => new Response(JSON.stringify(sampleChartsBody), { status: 200 }));
		await expect(handler({ deployment_id: "dep-eu-b2b", from: "2026-04-01", to: "2026-05-01" })).rejects.toBeInstanceOf(
			McpError,
		);
	});

	test("returns InvalidParams when no buckets match the deployment", async () => {
		const handler = makeHandler(
			{ defaultOrgId: "org-1" },
			async () => new Response(JSON.stringify(sampleChartsBody), { status: 200 }),
		);
		await expect(
			handler({ deployment_id: "dep-doesnt-exist", from: "2026-04-01", to: "2026-05-01" }),
		).rejects.toBeInstanceOf(McpError);
	});

	test("rejects when from/to are missing", async () => {
		const handler = makeHandler(
			{ defaultOrgId: "org-1" },
			async () => new Response(JSON.stringify(sampleChartsBody), { status: 200 }),
		);
		await expect(handler({ deployment_id: "dep-eu-b2b" })).rejects.toBeInstanceOf(McpError);
	});
});
