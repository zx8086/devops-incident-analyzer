// gitagent-bridge/src/hooks.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HooksConfigSchema, loadHooks } from "./hooks.ts";

function makeAgentDir(hooksYaml?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "gitagent-hooks-test-"));
	if (hooksYaml !== undefined) {
		mkdirSync(join(dir, "hooks"), { recursive: true });
		writeFileSync(join(dir, "hooks", "hooks.yaml"), hooksYaml);
	}
	return dir;
}

describe("HooksConfigSchema", () => {
	test("accepts bootstrap + teardown with valid step enums", () => {
		const result = HooksConfigSchema.safeParse({
			bootstrap: { instructions_file: "bootstrap.md", steps: ["load_live_memory", "emit_session_start"] },
			teardown: { instructions_file: "teardown.md", steps: ["flush_daily_log", "open_memory_pr"] },
		});
		expect(result.success).toBe(true);
	});

	test("accepts empty object (both phases optional)", () => {
		expect(HooksConfigSchema.safeParse({}).success).toBe(true);
	});

	test("rejects a bootstrap step that is not in the enum", () => {
		const result = HooksConfigSchema.safeParse({ bootstrap: { steps: ["rm_rf_slash"] } });
		expect(result.success).toBe(false);
	});

	test("rejects a teardown step from the bootstrap enum (phases are distinct)", () => {
		const result = HooksConfigSchema.safeParse({ teardown: { steps: ["load_live_memory"] } });
		expect(result.success).toBe(false);
	});

	test("rejects unknown top-level keys (strict)", () => {
		const result = HooksConfigSchema.safeParse({ startup: { steps: [] } });
		expect(result.success).toBe(false);
	});

	test("rejects unknown keys inside a phase (strict)", () => {
		const result = HooksConfigSchema.safeParse({ bootstrap: { shell: "echo hi" } });
		expect(result.success).toBe(false);
	});
});

describe("loadHooks", () => {
	test("returns undefined when hooks/hooks.yaml is absent", () => {
		const dir = makeAgentDir();
		try {
			expect(loadHooks(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("parses a valid hooks.yaml", () => {
		const dir = makeAgentDir(
			[
				"bootstrap:",
				"  steps: [load_live_memory, warm_knowledge_graph]",
				"teardown:",
				"  steps: [flush_daily_log]",
			].join("\n"),
		);
		try {
			const hooks = loadHooks(dir);
			expect(hooks?.bootstrap?.steps).toEqual(["load_live_memory", "warm_knowledge_graph"]);
			expect(hooks?.teardown?.steps).toEqual(["flush_daily_log"]);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("throws on an invalid step (schema enforced at load)", () => {
		const dir = makeAgentDir("bootstrap:\n  steps: [bogus_step]\n");
		try {
			expect(() => loadHooks(dir)).toThrow();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
