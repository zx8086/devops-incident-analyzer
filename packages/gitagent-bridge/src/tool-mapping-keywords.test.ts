// gitagent-bridge/src/tool-mapping-keywords.test.ts
import { describe, expect, test } from "bun:test";
import { matchActionsByKeywords } from "./tool-mapping.ts";
import type { ToolDefinition } from "./types.ts";

function makeToolDef(
	actionKeywords?: Record<string, string[]>,
	actionToolMap?: Record<string, string[]>,
): ToolDefinition {
	return {
		name: "test-tool",
		description: "A test tool",
		input_schema: {},
		tool_mapping: {
			mcp_server: "test",
			mcp_patterns: ["test_*"],
			action_tool_map: actionToolMap ?? Object.fromEntries(Object.keys(actionKeywords ?? {}).map((k) => [k, []])),
			action_keywords: actionKeywords,
		},
	};
}

describe("matchActionsByKeywords", () => {
	// 1. "check rest proxy" with keyword "rest proxy" mapped to restproxy
	test("1. matches multi-word keyword in query", () => {
		const def = makeToolDef({ restproxy: ["rest proxy"] });
		expect(matchActionsByKeywords("check rest proxy", def)).toEqual(["restproxy"]);
	});

	// 2. Case-insensitive: "REST Proxy" -> ["restproxy"]
	test("2. case-insensitive match", () => {
		const def = makeToolDef({ restproxy: ["rest proxy"] });
		expect(matchActionsByKeywords("REST Proxy", def)).toEqual(["restproxy"]);
	});

	// 3. "restproxy-foo" with keyword "rest proxy" -> [] (no word-boundary match for the multi-word keyword with a space)
	test("3. does not match when keyword phrase is not present", () => {
		const def = makeToolDef({ restproxy: ["rest proxy"] });
		expect(matchActionsByKeywords("restproxy-foo", def)).toEqual([]);
	});

	// 4. Word boundary: "reset" with keyword "rest" -> [] (rest is not a whole word in "reset")
	test("4. word boundary prevents partial match inside a word", () => {
		const def = makeToolDef({ rest_action: ["rest"] });
		expect(matchActionsByKeywords("reset", def)).toEqual([]);
	});

	// 5. "check kafka connect and the connector" with keywords ["kafka connect", "connector"] both for connect_status
	//    -> returns ["connect_status"] (deduped, a single action matched)
	test("5. deduplicates action when multiple keywords match", () => {
		const def = makeToolDef({ connect_status: ["kafka connect", "connector"] });
		const result = matchActionsByKeywords("check kafka connect and the connector", def);
		expect(result).toEqual(["connect_status"]);
	});

	// 6. "check connects" with keyword "connectors" (plural) -> [] (literal match required)
	test("6. does not match plural form when keyword is singular (or vice versa)", () => {
		const def = makeToolDef({ list_connectors: ["connectors"] });
		expect(matchActionsByKeywords("check connects", def)).toEqual([]);
	});

	// 7. Tool def with NO action_keywords field -> []
	test("7. tool def without action_keywords returns empty array", () => {
		const def: ToolDefinition = {
			name: "no-keywords-tool",
			description: "Tool without action_keywords",
			input_schema: {},
			tool_mapping: {
				mcp_server: "test",
				mcp_patterns: ["test_*"],
				action_tool_map: { some_action: ["test_tool"] },
				// action_keywords deliberately omitted
			},
		};
		expect(matchActionsByKeywords("any query", def)).toEqual([]);
	});

	// 8. Empty query string -> []
	test("8. empty query returns empty array", () => {
		const def = makeToolDef({ restproxy: ["rest proxy"] });
		expect(matchActionsByKeywords("", def)).toEqual([]);
	});

	// 9. Two different actions matched -> returns both (order-insensitive)
	test("9. returns both actions when different keywords match different actions", () => {
		const def = makeToolDef(
			{
				restproxy: ["rest proxy"],
				connect_status: ["connector"],
			},
			{
				restproxy: ["test_restproxy"],
				connect_status: ["test_connector"],
			},
		);
		const result = matchActionsByKeywords("check rest proxy and connector status", def);
		expect(result).toHaveLength(2);
		expect(result).toContain("restproxy");
		expect(result).toContain("connect_status");
	});

	// 10. Special regex characters in keyword must be matched literally
	test("10a. dot in keyword matches literal dot, not arbitrary character", () => {
		const def = makeToolDef({ version_check: ["v1.0"] });
		// Should match the literal "v1.0"
		expect(matchActionsByKeywords("deploy v1.0 to prod", def)).toEqual(["version_check"]);
		// Should NOT match "v1X0" (dot treated as regex wildcard would match this)
		expect(matchActionsByKeywords("deploy v1X0 to prod", def)).toEqual([]);
	});

	test("10b. dot-containing keyword does not behave as regex wildcard", () => {
		const def = makeToolDef({ api_check: ["a.b"] });
		// "a.b" as regex would match "axb" — it must NOT
		expect(matchActionsByKeywords("check axb endpoint", def)).toEqual([]);
		// Literal "a.b" must match
		expect(matchActionsByKeywords("check a.b endpoint", def)).toEqual(["api_check"]);
	});
});
