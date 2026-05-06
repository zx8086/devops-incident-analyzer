// tests/unit/tools/cloud/list_deployments.test.ts

import { beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CloudClient, type FetchLike } from "../../../../src/clients/cloudClient.js";
import type { ElasticCloudConfig } from "../../../../src/config/schemas.js";
import { registerCloudListDeploymentsTool } from "../../../../src/tools/cloud/list_deployments.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

const cloudCfg: ElasticCloudConfig = {
	apiKey: "test-key",
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 5000,
	maxRetries: 0,
};

type TestHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

describe("elasticsearch_cloud_list_deployments", () => {
	let handler: TestHandler;
	const calls: string[] = [];

	beforeAll(() => {
		const fetchImpl: FetchLike = async (url) => {
			calls.push(typeof url === "string" ? url : String(url));
			return new Response(
				JSON.stringify({
					deployments: [
						{ id: "71bdf337bb454d7ba192142d5a9925cf", name: "eu-b2b" },
						{ id: "another-id", name: "eu-cld" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};
		const cloudClient = new CloudClient(cloudCfg, fetchImpl);
		const server = new McpServer({ name: "test", version: "1.0.0" });
		registerCloudListDeploymentsTool(server, cloudClient);
		const tool = getToolFromServer(server, "elasticsearch_cloud_list_deployments");
		if (!tool) throw new Error("tool not registered");
		handler = tool.handler as TestHandler;
	});

	test("calls GET /api/v1/deployments and returns the JSON-encoded body", async () => {
		const result = await handler({});
		expect(calls[0]).toBe("https://api.elastic-cloud.com/api/v1/deployments");
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
			deployments: Array<{ id: string; name: string }>;
		};
		expect(parsed.deployments).toHaveLength(2);
		expect(parsed.deployments[0]?.id).toBe("71bdf337bb454d7ba192142d5a9925cf");
	});

	test("returns SearchResult shape with a single text content block", async () => {
		const result = await handler({});
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
	});
});
