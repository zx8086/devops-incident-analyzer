// packages/agent/src/entity-extractor.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@devops-agent/gitagent-bridge";
import { ExtractionSchema, formatActionCatalog } from "./entity-extractor.ts";
import { parseLlmJson } from "./llm-json.ts";

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

// SIO-1233: the production incident. On 2026-07-26 a query that named prana-order-service
// explicitly fanned out to all 7 datasources because the extractor logged:
//
//   warn: Entity extraction failed, falling back to all datasources
//     {"reason":"schema-mismatch","detail":"dataSources: Invalid input: expected array, received undefined"}
//
// dataSources is this schema's ONLY required field, so any drift in how the model spells or
// wraps it takes out the entire extraction. These assert against the PRODUCTION schema.
describe("ExtractionSchema envelope drift (SIO-1233 regression)", () => {
	test("REGRESSION: the reported failure -- snake_case data_sources -- now parses", () => {
		const drifted = '{"data_sources":[{"id":"kafka","mentionedAs":"kafka"}],"services":["prana-order-service"]}';
		const result = parseLlmJson(drifted, ExtractionSchema);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.dataSources).toEqual([{ id: "kafka", mentionedAs: "kafka" }]);
			expect(result.data.services).toEqual(["prana-order-service"]);
		}
	});

	test("REGRESSION: a container-key envelope now parses", () => {
		const wrapped = '{"entities":{"dataSources":[{"id":"elastic","mentionedAs":"logs"}]}}';
		const result = parseLlmJson(wrapped, ExtractionSchema);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.dataSources).toHaveLength(1);
	});

	test.each([
		["datasources", '{"datasources":[{"id":"aws","mentionedAs":"aws"}]}'],
		["sources", '{"sources":[{"id":"aws","mentionedAs":"aws"}]}'],
	])("tolerates the %s spelling", (_label, body) => {
		const result = parseLlmJson(body, ExtractionSchema);
		expect(result.ok).toBe(true);
	});

	test("maps time_from / time_to / tool_actions aliases", () => {
		const body =
			'{"dataSources":[],"time_from":"2026-07-26T00:00:00Z","time_to":"2026-07-26T01:00:00Z","tool_actions":{"kafka":["consumer_lag"]}}';
		const result = parseLlmJson(body, ExtractionSchema);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.timeFrom).toBe("2026-07-26T00:00:00Z");
			expect(result.data.timeTo).toBe("2026-07-26T01:00:00Z");
			expect(result.data.toolActions).toEqual({ kafka: ["consumer_lag"] });
		}
	});

	// toolActions is a z.record keyed by MODEL-AUTHORED datasource ids -- this is exactly why the
	// fix is an explicit alias map and not a blanket snake_case->camelCase rewrite.
	test("does NOT rewrite snake_case INSIDE toolActions keys or values", () => {
		const body = '{"dataSources":[],"toolActions":{"kafka":["consumer_lag","topic_throughput"]}}';
		const result = parseLlmJson(body, ExtractionSchema);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.toolActions).toEqual({ kafka: ["consumer_lag", "topic_throughput"] });
	});

	test("still fails loudly -- with observedKeys -- when dataSources is genuinely absent", () => {
		const result = parseLlmJson('{"severity":"high","services":["a-b"]}', ExtractionSchema);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("schema-mismatch");
			// Pinned to the incident log VERBATIM (verified byte-for-byte against the 2026-07-26
			// run). If a Zod upgrade reworded this, the message above stops matching the evidence
			// this ticket was diagnosed from -- which is worth knowing.
			expect(result.message).toBe("dataSources: Invalid input: expected array, received undefined");
			// The diagnostic that was missing during the incident.
			expect(result.observedKeys).toEqual(["severity", "services"]);
		}
	});
});
