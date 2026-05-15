// src/__tests__/bootstrap.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../config/schemas.ts";
import { registerAllTools } from "../tools/register.ts";
import { createTransport } from "../transport/index.ts";

const awsConfig: AwsConfig = {
	region: "eu-central-1",
	assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
	externalId: "aws-mcp-readonly-2026",
};

const PORT = 19085; // ephemeral test port to avoid collision

function buildServerFactory() {
	return () => {
		const server = new McpServer({ name: "aws-mcp-server", version: "0.1.0" });
		registerAllTools(server, awsConfig);
		return server;
	};
}

describe("HTTP transport", () => {
	let close: () => Promise<void>;

	beforeAll(async () => {
		const result = await createTransport(
			{ mode: "http", port: PORT, host: "127.0.0.1", path: "/mcp" },
			buildServerFactory(),
		);
		close = result.closeAll;
	});

	afterAll(async () => {
		await close();
	});

	test("GET /ping returns 200", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/ping`);
		expect(res.status).toBe(200);
	});

	test("GET /health returns 200 with JSON", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/health`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	test("GET /mcp returns 405", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/mcp`);
		expect(res.status).toBe(405);
	});

	test("Unknown path returns 404", async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}/nonexistent`);
		expect(res.status).toBe(404);
	});
});
