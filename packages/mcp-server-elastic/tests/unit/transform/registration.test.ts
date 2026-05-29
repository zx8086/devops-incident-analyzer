// tests/unit/transform/registration.test.ts
// SIO-830: Verifies that all 10 transform tools register with the MCP server
// and that the 5 read tools are excluded from the security-validation wrapper.

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../../../src/tools/index.js";

const EXPECTED_TRANSFORM_TOOLS = [
	"elasticsearch_get_transform",
	"elasticsearch_get_transform_stats",
	"elasticsearch_list_transforms",
	"elasticsearch_start_transform",
	"elasticsearch_stop_transform",
	"elasticsearch_put_transform",
	"elasticsearch_update_transform",
	"elasticsearch_delete_transform",
	"elasticsearch_preview_transform",
	"elasticsearch_get_transform_notifications",
] as const;

describe("SIO-830: transform tool registration", () => {
	test("all 10 transform tools are registered with the MCP server", () => {
		const server = new McpServer({ name: "test-server", version: "0.0.0" });
		// The client is only used inside handlers — never called during registration —
		// so a typed shim suffices for this static-surface check.
		const fakeClient = {} as Parameters<typeof registerAllTools>[1];

		const registered = registerAllTools(server, fakeClient);
		const registeredNames = new Set(registered.map((t) => t.name));

		for (const name of EXPECTED_TRANSFORM_TOOLS) {
			expect(registeredNames.has(name)).toBe(true);
		}
	});

	test("transform tool count matches expected (10)", () => {
		const server = new McpServer({ name: "test-server", version: "0.0.0" });
		const fakeClient = {} as Parameters<typeof registerAllTools>[1];

		const registered = registerAllTools(server, fakeClient);
		const transformCount = registered.filter((t) => t.name.includes("transform")).length;

		expect(transformCount).toBe(10);
	});

	test("transform read tools are in READ_ONLY_TOOLS (no security wrapper)", () => {
		// Indirect verification: descriptions for read tools must not say WRITE/DESTRUCTIVE.
		const server = new McpServer({ name: "test-server", version: "0.0.0" });
		const fakeClient = {} as Parameters<typeof registerAllTools>[1];
		const registered = registerAllTools(server, fakeClient);

		const readOnlyTransformTools = [
			"elasticsearch_get_transform",
			"elasticsearch_get_transform_stats",
			"elasticsearch_list_transforms",
			"elasticsearch_preview_transform",
			"elasticsearch_get_transform_notifications",
		];

		for (const name of readOnlyTransformTools) {
			const tool = registered.find((t) => t.name === name);
			expect(tool).toBeDefined();
			expect(tool?.description.toUpperCase()).not.toContain("WRITE OPERATION");
			expect(tool?.description.toUpperCase()).not.toContain("DESTRUCTIVE");
		}
	});

	test("transform write/destructive tools call out their nature in descriptions", () => {
		const server = new McpServer({ name: "test-server", version: "0.0.0" });
		const fakeClient = {} as Parameters<typeof registerAllTools>[1];
		const registered = registerAllTools(server, fakeClient);

		const writeToolDescriptions: Record<string, RegExp> = {
			elasticsearch_start_transform: /WRITE OPERATION/,
			elasticsearch_stop_transform: /WRITE OPERATION/,
			elasticsearch_put_transform: /WRITE OPERATION/,
			elasticsearch_update_transform: /WRITE OPERATION/,
			elasticsearch_delete_transform: /DESTRUCTIVE OPERATION/,
		};

		for (const [name, pattern] of Object.entries(writeToolDescriptions)) {
			const tool = registered.find((t) => t.name === name);
			expect(tool).toBeDefined();
			expect(tool?.description).toMatch(pattern);
		}
	});
});
