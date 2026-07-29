// agent/src/iac/knowledge-selector-sync.test.ts
//
// SIO-1285, applying the SIO-1003 discipline: knowledge_selection.by_intent is a
// HAND-MAINTAINED mapping keyed on an enum, which is exactly the shape of the bug SIO-1003
// fixed (cluster-settings-edit was in the schema but missing from the instruction prose,
// so the LLM could not select a shipped workflow). These tests pin the map to the enum in
// both directions, and pin the one invariant that is easy to "optimise" away.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgent } from "@devops-agent/gitagent-bridge";
import { ALL_LIVE_CATEGORIES, DEFAULT_BY_INTENT } from "./knowledge-selector.ts";
import { intentFromText } from "./nodes.ts";
import { INTENT_VALUES } from "./state.ts";

const IAC_DIR = join(import.meta.dir, "../../../../agents/elastic-iac");

describe("knowledge selection enum sync (SIO-1285)", () => {
	test("DEFAULT_BY_INTENT maps EVERY INTENT_VALUES member", () => {
		for (const intent of INTENT_VALUES) {
			expect(DEFAULT_BY_INTENT[intent]).toBeDefined();
			expect(DEFAULT_BY_INTENT[intent].length).toBeGreaterThan(0);
		}
	});

	test("index.yaml by_intent maps EVERY INTENT_VALUES member", () => {
		const cfg = loadAgent(IAC_DIR).knowledgeSelection;
		expect(cfg).toBeDefined();
		for (const intent of INTENT_VALUES) {
			expect(cfg?.by_intent[intent]).toBeDefined();
		}
	});

	test("index.yaml by_intent declares NOTHING extra (a renamed intent cannot linger)", () => {
		const cfg = loadAgent(IAC_DIR).knowledgeSelection;
		const known: readonly string[] = INTENT_VALUES;
		for (const key of Object.keys(cfg?.by_intent ?? {})) {
			expect(known).toContain(key);
		}
	});

	test("every category referenced by the config exists in index.yaml categories", () => {
		const agent = loadAgent(IAC_DIR);
		const cfg = agent.knowledgeSelection;
		const declared = new Set(agent.knowledge.map((k) => k.category));
		for (const list of Object.values(cfg?.by_intent ?? {})) {
			for (const category of list) expect(declared.has(category)).toBe(true);
		}
		for (const category of cfg?.floor ?? []) expect(declared.has(category)).toBe(true);
	});

	// The load-bearing invariant. intentFromText (nodes.ts) returns "info" for ANYTHING it
	// does not recognise, so "info" is not a category of request -- it is every novel,
	// ambiguous or misclassified one. Narrowing it would silently starve them all, with no
	// error: the agent would simply reason from less. This test exists so that a future
	// well-meaning prompt-cost optimisation fails CI instead of degrading judgment.
	test("'info' -- the classifier catch-all -- is NEVER narrowed", () => {
		expect([...DEFAULT_BY_INTENT.info].sort()).toEqual([...ALL_LIVE_CATEGORIES].sort());

		const cfg = loadAgent(IAC_DIR).knowledgeSelection;
		expect([...(cfg?.by_intent.info ?? [])].sort()).toEqual([...ALL_LIVE_CATEGORIES].sort());
	});

	test("every output intentFromText can produce is a mapped intent, gibberish included", () => {
		for (const raw of [
			"pipeline-status",
			"fleet upgrade",
			"synthetic",
			"drift",
			"gitops",
			"converse",
			"info",
			"total gibberish that matches nothing",
			"",
		]) {
			expect(DEFAULT_BY_INTENT[intentFromText(raw)]).toBeDefined();
		}
	});
});
