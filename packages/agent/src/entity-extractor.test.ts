// packages/agent/src/entity-extractor.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@devops-agent/gitagent-bridge";
import { formatActionCatalog } from "./entity-extractor.ts";

function makeTool(
	server: string,
	actionMap: Record<string, string[]>,
	descriptions?: Record<string, string>,
): ToolDefinition {
	return {
		name: `${server}-facade`,
		description: "fixture",
		input_schema: {},
		tool_mapping: {
			mcp_server: server,
			mcp_patterns: [`${server}_*`],
			action_tool_map: actionMap,
			...(descriptions ? { action_descriptions: descriptions } : {}),
		},
	};
}

describe("formatActionCatalog", () => {
	test("emits indented multi-line format when descriptions are present", () => {
		const tools = [
			makeTool(
				"kafka",
				{ consumer_lag: ["k_a"], topic_throughput: ["k_b"] },
				{ consumer_lag: "when groups have rising lag", topic_throughput: "when investigating topic rates" },
			),
		];
		const out = formatActionCatalog(tools);
		expect(out).toContain("- kafka:\n");
		expect(out).toContain("  - consumer_lag — when groups have rising lag");
		expect(out).toContain("  - topic_throughput — when investigating topic rates");
		expect(out).not.toContain("- kafka: consumer_lag");
	});

	test("emits comma-separated format when descriptions are absent", () => {
		const tools = [makeTool("elastic", { search_logs: ["e_a"], count_documents: ["e_b"] })];
		const out = formatActionCatalog(tools);
		expect(out).toContain("- elastic: search_logs, count_documents");
		expect(out).not.toContain("  - search_logs");
	});

	test("decides format per-tool: kafka indented, elastic flat in same agent", () => {
		const tools = [makeTool("kafka", { a: ["k_a"] }, { a: "kafka description" }), makeTool("elastic", { b: ["e_b"] })];
		const out = formatActionCatalog(tools);
		expect(out).toContain("- kafka:\n  - a — kafka description");
		expect(out).toContain("- elastic: b");
	});

	test("returns empty string when no tools have action_tool_map", () => {
		const tools: ToolDefinition[] = [
			{ name: "x", description: "x", input_schema: {}, tool_mapping: { mcp_server: "x", mcp_patterns: ["x_*"] } },
		];
		expect(formatActionCatalog(tools)).toBe("");
	});

	test("falls back to bare name for actions missing description in a partially-described tool", () => {
		const tools = [makeTool("kafka", { a: ["k_a"], b: ["k_b"] }, { a: "alpha only" })];
		const out = formatActionCatalog(tools);
		expect(out).toContain("- kafka:\n");
		expect(out).toContain("  - a — alpha only");
		expect(out).toContain("  - b\n");
		expect(out).not.toContain("  - b — ");
	});
});
