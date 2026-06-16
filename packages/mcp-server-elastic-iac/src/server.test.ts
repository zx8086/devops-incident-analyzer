// src/server.test.ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";

describe("elastic-iac MCP server", () => {
	test("loadConfig applies env defaults (port 9086, IaC project)", () => {
		const config = loadConfig();
		expect(config.transport.port).toBe(9086);
		expect(config.transport.path).toBe("/mcp");
		expect(config.repository.projectId).toBe("82850717");
		expect(config.taskBin).toBe("task");
	});

	test("createServer registers tools without throwing", () => {
		const server = createServer(loadConfig());
		expect(server).toBeDefined();
		// McpServer exposes a connect method; structural smoke check.
		expect(typeof server.connect).toBe("function");
	});
});
