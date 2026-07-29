// agent/src/iac/knowledge-selector.test.ts
//
// SIO-1285: contract tests for the elastic-iac knowledge selector. Uses the real
// loadAgent (gitagent-bridge is NOT mocked) and never touches getAgentByName, so this
// suite is immune to the process-global mock.module("../prompt-context.ts") that sibling
// suites register (see reference_prompt_context_mock_pollutes_direct_imports).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSystemPrompt, loadAgent } from "@devops-agent/gitagent-bridge";
import {
	ALL_LIVE_CATEGORIES,
	DEFAULT_BY_INTENT,
	filterAgentKnowledge,
	selectCategories,
} from "./knowledge-selector.ts";
import { INTENT_VALUES } from "./state.ts";

const IAC_DIR = join(import.meta.dir, "../../../../agents/elastic-iac");

describe("filterAgentKnowledge contract (SIO-1285)", () => {
	test("null/undefined is a pass-through returning the SAME object identity", () => {
		const agent = loadAgent(IAC_DIR);
		expect(filterAgentKnowledge(agent, null)).toBe(agent);
		expect(filterAgentKnowledge(agent, undefined)).toBe(agent);
	});

	test("does NOT mutate the input agent -- getAgentByName hands out a process-global cache", () => {
		const agent = loadAgent(IAC_DIR);
		const before = agent.knowledge.length;
		const filtered = filterAgentKnowledge(agent, ["reference"]);
		expect(agent.knowledge.length).toBe(before);
		expect(filtered.knowledge.length).toBeLessThan(before);
		// the original array object is untouched, not just equal in length
		expect(filtered.knowledge).not.toBe(agent.knowledge);
	});

	test("keeps exactly the named categories and drops the rest", () => {
		const agent = loadAgent(IAC_DIR);
		const filtered = filterAgentKnowledge(agent, ["reference"]);
		expect(filtered.knowledge.length).toBeGreaterThan(0);
		expect(new Set(filtered.knowledge.map((k) => k.category))).toEqual(new Set(["reference"]));
	});

	test("empty array drops all knowledge", () => {
		const agent = loadAgent(IAC_DIR);
		expect(filterAgentKnowledge(agent, []).knowledge).toHaveLength(0);
	});

	test("an unknown category name yields no entries rather than throwing", () => {
		const agent = loadAgent(IAC_DIR);
		expect(filterAgentKnowledge(agent, ["no-such-category"]).knowledge).toHaveLength(0);
	});
});

describe("selectCategories fallback behaviour (SIO-1285)", () => {
	const cfg = loadAgent(IAC_DIR).knowledgeSelection;

	test("a null intent falls back to the FULL set, never a narrow one", () => {
		expect(new Set(selectCategories(null, cfg))).toEqual(new Set(ALL_LIVE_CATEGORIES));
	});

	test("an absent config still resolves every intent via DEFAULT_BY_INTENT", () => {
		for (const intent of INTENT_VALUES) {
			expect(selectCategories(intent, undefined).length).toBeGreaterThan(0);
		}
	});

	test("an intent mapped to an empty list falls back to the FULL set", () => {
		const empty = { by_intent: { gitops: [] }, floor: [] };
		expect(new Set(selectCategories("gitops", empty))).toEqual(new Set(ALL_LIVE_CATEGORIES));
	});

	test("an intent missing from by_intent falls back to its DEFAULT, not to nothing", () => {
		const partial = { by_intent: { gitops: ["reference"] }, floor: [] };
		expect(selectCategories("converse", partial)).toEqual([...DEFAULT_BY_INTENT.converse]);
	});

	test("the floor is unioned into every selection and never duplicated", () => {
		const withFloor = { by_intent: { converse: ["runbooks"] }, floor: ["reference"] };
		const picked = selectCategories("converse", withFloor);
		expect(picked).toContain("reference");
		expect(picked).toContain("runbooks");
		expect(picked.length).toBe(new Set(picked).size);
	});

	test("every selection for every intent includes the configured floor", () => {
		if (!cfg) return;
		for (const intent of INTENT_VALUES) {
			for (const floorCategory of cfg.floor) {
				expect(selectCategories(intent, cfg)).toContain(floorCategory);
			}
		}
	});
});

describe("prompt-size effect (SIO-1285)", () => {
	test("converse is strictly smaller than gitops, which is strictly smaller than unfiltered", () => {
		const agent = loadAgent(IAC_DIR);
		const cfg = agent.knowledgeSelection;
		const size = (intent: (typeof INTENT_VALUES)[number]) =>
			buildSystemPrompt(filterAgentKnowledge(agent, selectCategories(intent, cfg))).length;
		const unfiltered = buildSystemPrompt(agent).length;
		expect(size("converse")).toBeLessThan(size("gitops"));
		expect(size("gitops")).toBeLessThan(unfiltered);
	});

	test("the gate-off path is byte-identical to the unfiltered prompt", () => {
		const agent = loadAgent(IAC_DIR);
		// selectedKnowledge stays null when the selector never runs.
		expect(buildSystemPrompt(filterAgentKnowledge(agent, null))).toBe(buildSystemPrompt(agent));
	});
});
