// tests/unit/tools/cloud/cancel_pending_plan.test.ts

import { beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerCloudCancelPendingPlanTool } from "../../../../src/tools/cloud/cancel_pending_plan.js";
import { initializeReadOnlyManager } from "../../../../src/utils/readOnlyMode.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

const cfg: ElasticCloudConfig = {
	apiKey: "k",
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 5000,
	maxRetries: 0,
};

function makeHandler(fetchImpl: FetchLike) {
	const server = new McpServer({ name: "t", version: "1.0.0" });
	registerCloudCancelPendingPlanTool(server, new CloudClient(cfg, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_cloud_cancel_pending_plan");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_cloud_cancel_pending_plan", () => {
	beforeAll(() => {
		// Default: write enabled. Individual tests flip into read-only mode as needed.
		initializeReadOnlyManager(false, true);
	});

	test("defaults resource_kind=elasticsearch and ref_id=main-elasticsearch, uses DELETE method", async () => {
		let url = "";
		let method = "";
		const handler = makeHandler(async (u, init) => {
			url = String(u);
			method = init?.method ?? "";
			return new Response(JSON.stringify({ id: "deploy-1" }), { status: 200 });
		});
		await handler({ deployment_id: "abc" });
		expect(method).toBe("DELETE");
		expect(new URL(url).pathname).toBe("/api/v1/deployments/abc/elasticsearch/main-elasticsearch/plan/pending");
	});

	test("forwards force_delete and ignore_missing as query params", async () => {
		let url = "";
		const handler = makeHandler(async (u) => {
			url = String(u);
			return new Response("{}", { status: 200 });
		});
		await handler({ deployment_id: "abc", force_delete: true, ignore_missing: true });
		const u = new URL(url);
		expect(u.searchParams.get("force_delete")).toBe("true");
		expect(u.searchParams.get("ignore_missing")).toBe("true");
	});

	test("respects an explicit resource_kind", async () => {
		let url = "";
		const handler = makeHandler(async (u) => {
			url = String(u);
			return new Response("{}", { status: 200 });
		});
		await handler({ deployment_id: "abc", resource_kind: "kibana", ref_id: "main-kibana" });
		expect(new URL(url).pathname).toBe("/api/v1/deployments/abc/kibana/main-kibana/plan/pending");
	});

	test("blocks the call when read-only strict mode is enabled", async () => {
		initializeReadOnlyManager(true, true);
		let fetched = false;
		const handler = makeHandler(async () => {
			fetched = true;
			return new Response("{}", { status: 200 });
		});
		const result = await handler({ deployment_id: "abc" });
		expect(fetched).toBe(false);
		expect(result.content[0]?.text ?? "").toContain("READ-ONLY MODE");
		// Reset back to write-enabled so subsequent tests are unaffected.
		initializeReadOnlyManager(false, true);
	});

	test("rejects empty deployment_id at validation", async () => {
		const handler = makeHandler(async () => new Response("{}", { status: 200 }));
		await expect(handler({ deployment_id: "" })).rejects.toBeInstanceOf(McpError);
	});
});
