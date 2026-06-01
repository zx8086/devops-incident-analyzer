// agent/src/lifecycle.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// SIO-862: runBootstrap/runTeardown read getAgent().hooks from ./prompt-context.ts.
// Several sibling test files (mitigation.deadline, aggregate-mitigation, ...) call
// mock.module("./prompt-context.ts") with a getAgent stub that omits `hooks`. Bun's
// mock.module is process-global, so whichever loads before this file leaves
// getAgent().hooks undefined -> empty stepsRun and these tests fail only in the full
// suite (they pass in isolation). Owning the mock here -- and re-asserting it in
// beforeEach so it wins regardless of load order -- makes the lifecycle suite
// pollution-proof. The stub mirrors agents/incident-analyzer/hooks/hooks.yaml.
const HOOKS_STUB = {
	bootstrap: { steps: ["load_live_memory", "load_wiki_index", "warm_knowledge_graph", "emit_session_start"] },
	teardown: { steps: ["flush_daily_log", "checkpoint_key_decisions", "open_memory_pr"] },
};

function installPromptContextMock(): void {
	mock.module("./prompt-context.ts", () => ({
		getAgent: () => ({ manifest: {}, hooks: HOOKS_STUB, memory: { wiki: { indexMd: "" } } }),
	}));
}
installPromptContextMock();

import { registerGraphWarmer, registerMemoryPrOpener, runBootstrap, runTeardown } from "./lifecycle.ts";

const prevEnabled = process.env.LIVE_MEMORY_ENABLED;

beforeEach(() => {
	// Re-assert the prompt-context mock so a sibling file's load-time mock cannot win.
	installPromptContextMock();
	// Bootstrap's load_live_memory reads runtime files; enable so it returns content.
	process.env.LIVE_MEMORY_ENABLED = "true";
});

afterEach(() => {
	if (prevEnabled === undefined) delete process.env.LIVE_MEMORY_ENABLED;
	else process.env.LIVE_MEMORY_ENABLED = prevEnabled;
	// Reset registered seams to a no-op so tests don't leak into each other.
	registerGraphWarmer(async () => {});
	registerMemoryPrOpener(async () => {});
});

describe("runBootstrap", () => {
	test("runs the agent's configured bootstrap steps in order", async () => {
		const result = await runBootstrap();
		// The production hooks.yaml declares all four bootstrap steps.
		expect(result.stepsRun).toEqual([
			"load_live_memory",
			"load_wiki_index",
			"warm_knowledge_graph",
			"emit_session_start",
		]);
		// load_live_memory populated context from memory/runtime/context.md
		expect(result.liveMemoryContext).toContain("Live Context");
	});

	test("invokes a registered graph warmer during warm_knowledge_graph", async () => {
		let warmed = false;
		registerGraphWarmer(async () => {
			warmed = true;
		});
		await runBootstrap();
		expect(warmed).toBe(true);
	});

	test("tolerates a graph warmer that throws (best-effort)", async () => {
		registerGraphWarmer(async () => {
			throw new Error("graph unreachable");
		});
		// Should not reject; the failure is swallowed and logged.
		const result = await runBootstrap();
		expect(result.stepsRun).toContain("warm_knowledge_graph");
	});
});

describe("runTeardown", () => {
	test("runs the agent's configured teardown steps in order", async () => {
		const steps = await runTeardown();
		expect(steps).toEqual(["flush_daily_log", "checkpoint_key_decisions", "open_memory_pr"]);
	});

	test("invokes a registered memory-pr opener during open_memory_pr", async () => {
		let opened = false;
		registerMemoryPrOpener(async () => {
			opened = true;
		});
		await runTeardown();
		expect(opened).toBe(true);
	});

	test("tolerates a memory-pr opener that throws (best-effort)", async () => {
		registerMemoryPrOpener(async () => {
			throw new Error("github down");
		});
		const steps = await runTeardown();
		expect(steps).toContain("open_memory_pr");
	});
});
