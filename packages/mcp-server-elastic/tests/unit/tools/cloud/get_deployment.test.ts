// tests/unit/tools/cloud/get_deployment.test.ts

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerCloudGetDeploymentTool } from "../../../../src/tools/cloud/get_deployment.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

const cfg: ElasticCloudConfig = {
	apiKey: "k",
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 5000,
	maxRetries: 0,
};

function makeHandler(fetchImpl: FetchLike) {
	const server = new McpServer({ name: "t", version: "1.0.0" });
	registerCloudGetDeploymentTool(server, new CloudClient(cfg, fetchImpl));
	const tool = getToolFromServer(server, "elasticsearch_cloud_get_deployment");
	if (!tool) throw new Error("not registered");
	return tool.handler as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("elasticsearch_cloud_get_deployment", () => {
	test("encodes deployment_id and forwards show_* booleans as query params", async () => {
		let capturedUrl = "";
		const handler = makeHandler(async (url) => {
			capturedUrl = String(url);
			return new Response(JSON.stringify({ id: "abc", resources: { elasticsearch: [] } }), { status: 200 });
		});
		await handler({ deployment_id: "abc/with/slashes", show_plans: true, show_metadata: false });
		const u = new URL(capturedUrl);
		expect(u.pathname).toBe("/api/v1/deployments/abc%2Fwith%2Fslashes");
		expect(u.searchParams.get("show_plans")).toBe("true");
		expect(u.searchParams.get("show_metadata")).toBe("false");
		expect(u.searchParams.get("show_security")).toBeNull();
	});

	test("rejects empty deployment_id at validation", async () => {
		const handler = makeHandler(async () => new Response("{}", { status: 200 }));
		await expect(handler({ deployment_id: "" })).rejects.toBeInstanceOf(McpError);
	});

	test("returns the JSON response in a single text content block", async () => {
		const handler = makeHandler(
			async () => new Response(JSON.stringify({ id: "eu-b2b", name: "eu-b2b" }), { status: 200 }),
		);
		const result = await handler({ deployment_id: "eu-b2b" });
		expect(result.content).toHaveLength(1);
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { id: string };
		expect(parsed.id).toBe("eu-b2b");
	});
});
