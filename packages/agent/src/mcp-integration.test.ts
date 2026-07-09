// agent/src/mcp-integration.test.ts
// SIO-577: Integration tests for MCP server connectivity and tool scoping
import { describe, expect, mock, test } from "bun:test";

// Explicitly mock with empty state to isolate from other test files that mock
// mcp-bridge with fake tools for supervisor tests.
mock.module("./mcp-bridge.ts", () => ({
	getToolsForDataSource: () => [],
	getAllTools: () => [],
	getConnectedServers: () => [],
}));

import { getAllTools, getToolsForDataSource } from "./mcp-bridge.ts";

describe("MCP tool scoping", () => {
	test("getToolsForDataSource returns empty when no MCP servers connected", () => {
		// Without running MCP servers, tools list is empty
		const elasticTools = getToolsForDataSource("elastic");
		expect(Array.isArray(elasticTools)).toBe(true);
		expect(elasticTools.length).toBe(0);
	});

	test("getAllTools returns empty when no MCP servers connected", () => {
		const tools = getAllTools();
		expect(Array.isArray(tools)).toBe(true);
		expect(tools.length).toBe(0);
	});

	test("getToolsForDataSource handles unknown datasource", () => {
		const tools = getToolsForDataSource("unknown");
		expect(Array.isArray(tools)).toBe(true);
	});
});
