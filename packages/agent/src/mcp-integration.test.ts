// agent/src/mcp-integration.test.ts
// SIO-577: Integration tests for MCP server connectivity and tool scoping
import { describe, expect, test } from "bun:test";
import { getAllTools, getToolsForDataSource } from "./mcp-bridge.ts";
import { getEnhancedDescription, getRelatedToolsMap, getToolPrompts } from "./prompt-overlay.ts";

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

describe("gitagent prompt overlay", () => {
	test("getToolPrompts returns prompts for all 6 tools", () => {
		const prompts = getToolPrompts();
		expect(prompts.size).toBe(6);
		expect(prompts.has("elastic-search-logs")).toBe(true);
		expect(prompts.has("kafka-introspect")).toBe(true);
		expect(prompts.has("couchbase-cluster-health")).toBe(true);
		expect(prompts.has("konnect-api-gateway")).toBe(true);
		expect(prompts.has("notify-slack")).toBe(true);
		expect(prompts.has("create-ticket")).toBe(true);
	});

	test("getRelatedToolsMap returns hints for datasource tools", () => {
		const map = getRelatedToolsMap();
		expect(map.size).toBeGreaterThan(0);
		const elasticHints = map.get("elastic-search-logs");
		expect(elasticHints).toBeDefined();
		expect(elasticHints!.some((h) => h.includes("kafka"))).toBe(true);
	});

	test("getEnhancedDescription maps MCP tool to gitagent prompt", () => {
		const desc = getEnhancedDescription("elasticsearch_search");
		expect(desc).toBeDefined();
		expect(desc).toContain("Elasticsearch");
	});

	test("getEnhancedDescription returns undefined for unmapped tool", () => {
		const desc = getEnhancedDescription("some_random_tool");
		expect(desc).toBeUndefined();
	});

	test("dynamic prompts resolve datasource context", () => {
		const prompts = getToolPrompts();
		const elasticPrompt = prompts.get("elastic-search-logs")!;
		expect(elasticPrompt).toContain("elastic");
		expect(elasticPrompt).toContain("kafka");
		expect(elasticPrompt).toContain("couchbase");
		expect(elasticPrompt).toContain("konnect");
	});

	test("dynamic prompts resolve compliance tier", () => {
		const prompts = getToolPrompts();
		const elasticPrompt = prompts.get("elastic-search-logs")!;
		expect(elasticPrompt).toContain("medium");
	});
});
