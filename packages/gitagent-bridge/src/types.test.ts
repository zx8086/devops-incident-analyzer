// packages/gitagent-bridge/src/types.test.ts
import { describe, expect, test } from "bun:test";
import { ToolDefinitionSchema } from "./types.ts";

describe("ToolDefinitionSchema action_descriptions", () => {
	test("accepts descriptions whose keys are a subset of action_tool_map keys", () => {
		const result = ToolDefinitionSchema.safeParse({
			name: "x",
			description: "x",
			input_schema: {},
			tool_mapping: {
				mcp_server: "x",
				mcp_patterns: ["x_*"],
				action_tool_map: { a: ["x_a"], b: ["x_b"] },
				action_descriptions: { a: "alpha" },
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects descriptions referencing keys absent from action_tool_map", () => {
		const result = ToolDefinitionSchema.safeParse({
			name: "x",
			description: "x",
			input_schema: {},
			tool_mapping: {
				mcp_server: "x",
				mcp_patterns: ["x_*"],
				action_tool_map: { a: ["x_a"] },
				action_descriptions: { a: "alpha", ghost: "boo" },
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const offendingPaths = result.error.issues.flatMap((i) => i.path);
			expect(offendingPaths.includes("ghost")).toBe(true);
		}
	});

	test("accepts tool_mapping with no action_descriptions at all", () => {
		const result = ToolDefinitionSchema.safeParse({
			name: "x",
			description: "x",
			input_schema: {},
			tool_mapping: {
				mcp_server: "x",
				mcp_patterns: ["x_*"],
				action_tool_map: { a: ["x_a"] },
			},
		});
		expect(result.success).toBe(true);
	});
});
