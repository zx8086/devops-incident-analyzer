// tests/unit/ml/registration.test.ts
// SIO-1148: Verifies all 9 ML anomaly-detection tools register with the MCP server,
// that the 4 read tools skip the security-validation wrapper (in READ_ONLY_TOOLS), and
// that the 5 write tools do not — with reset_job flagged DESTRUCTIVE.

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_TOOLS, registerAllTools } from "../../../src/tools/index.js";

const ML_READ_TOOLS = [
	"elasticsearch_ml_list_jobs",
	"elasticsearch_ml_get_job_stats",
	"elasticsearch_ml_get_datafeeds",
	"elasticsearch_ml_get_datafeed_stats",
] as const;

const ML_WRITE_TOOLS = [
	"elasticsearch_ml_open_job",
	"elasticsearch_ml_close_job",
	"elasticsearch_ml_start_datafeed",
	"elasticsearch_ml_stop_datafeed",
	"elasticsearch_ml_reset_job",
] as const;

const ALL_ML_TOOLS = [...ML_READ_TOOLS, ...ML_WRITE_TOOLS];

describe("SIO-1148: ML tool registration", () => {
	test("all 9 ML tools are registered with the MCP server", () => {
		const server = new McpServer({ name: "test-server", version: "0.0.0" });
		// The client is only used inside handlers — never during registration — so a typed shim suffices.
		const fakeClient = {} as Parameters<typeof registerAllTools>[1];

		const registered = registerAllTools(server, fakeClient);
		const registeredNames = new Set(registered.map((t) => t.name));

		for (const name of ALL_ML_TOOLS) {
			expect(registeredNames.has(name)).toBe(true);
		}
	});

	test("ML tool count matches expected (9)", () => {
		const server = new McpServer({ name: "test-server", version: "0.0.0" });
		const fakeClient = {} as Parameters<typeof registerAllTools>[1];

		const registered = registerAllTools(server, fakeClient);
		const mlCount = registered.filter((t) => t.name.startsWith("elasticsearch_ml_")).length;

		expect(mlCount).toBe(9);
	});

	test("ML read tools are in READ_ONLY_TOOLS (skips security-validation wrapper)", () => {
		for (const name of ML_READ_TOOLS) {
			expect(READ_ONLY_TOOLS.has(name)).toBe(true);
		}
	});

	test("ML write/destructive tools are NOT in READ_ONLY_TOOLS", () => {
		for (const name of ML_WRITE_TOOLS) {
			expect(READ_ONLY_TOOLS.has(name)).toBe(false);
		}
	});

	test("ML read tool descriptions do not claim WRITE/DESTRUCTIVE (description-rot canary)", () => {
		const server = new McpServer({ name: "test-server", version: "0.0.0" });
		const fakeClient = {} as Parameters<typeof registerAllTools>[1];
		const registered = registerAllTools(server, fakeClient);

		for (const name of ML_READ_TOOLS) {
			const tool = registered.find((t) => t.name === name);
			expect(tool).toBeDefined();
			expect(tool?.description.toUpperCase()).not.toContain("WRITE OPERATION");
			expect(tool?.description.toUpperCase()).not.toContain("DESTRUCTIVE");
		}
	});

	test("ML write tools call out their nature in descriptions; reset_job is DESTRUCTIVE", () => {
		const server = new McpServer({ name: "test-server", version: "0.0.0" });
		const fakeClient = {} as Parameters<typeof registerAllTools>[1];
		const registered = registerAllTools(server, fakeClient);

		const writeToolDescriptions: Record<string, RegExp> = {
			elasticsearch_ml_open_job: /WRITE OPERATION/,
			elasticsearch_ml_close_job: /WRITE OPERATION/,
			elasticsearch_ml_start_datafeed: /WRITE OPERATION/,
			elasticsearch_ml_stop_datafeed: /WRITE OPERATION/,
			elasticsearch_ml_reset_job: /DESTRUCTIVE OPERATION/,
		};

		for (const [name, pattern] of Object.entries(writeToolDescriptions)) {
			const tool = registered.find((t) => t.name === name);
			expect(tool).toBeDefined();
			expect(tool?.description).toMatch(pattern);
		}
	});
});
