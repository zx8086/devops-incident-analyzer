// agent/src/iac/knowledge-selector.test.ts
//
// SIO-1285: contract tests for the elastic-iac knowledge selector. Uses the real
// loadAgent (gitagent-bridge is NOT mocked) and never touches getAgentByName, so this
// suite is immune to the process-global mock.module("../prompt-context.ts") that sibling
// suites register (see reference_prompt_context_mock_pollutes_direct_imports).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt, type KnowledgeEntry, loadAgent } from "@devops-agent/gitagent-bridge";
import {
	ALL_LIVE_CATEGORIES,
	DEFAULT_BY_INTENT,
	excludeDeprecated,
	filterAgentKnowledge,
	selectCategories,
	selectIacKnowledge,
	staleEntries,
} from "./knowledge-selector.ts";
import { TURN_START_RESET } from "./nodes.ts";
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

// SIO-1285 (CodeRabbit, PR #523): selectedKnowledge is checkpointed per thread with a
// last-write-wins reducer, so a node returning {} applies NO update and the previous turn's
// selection survives. A converse turn narrowed to [reference, runbooks] followed by a gitops
// turn whose selector fell back would have run parseIntent on the converse set -- the exact
// starvation the fallback exists to prevent. Every non-selecting path must return an
// EXPLICIT null. Same bug class as SIO-1020's TURN_START_RESET.
describe("fallback clears prior selection, never leaves it stale (SIO-1285)", () => {
	// The node's non-selecting paths must WRITE null rather than omit the key. Asserted on the
	// source because both paths (config absent, and the catch block) depend on repo config or a
	// thrown error that this suite cannot induce without mocking the process-global agent cache.
	test("every non-selecting return writes an explicit null, never a bare {}", () => {
		const src = readFileSync(join(import.meta.dir, "knowledge-selector.ts"), "utf-8");
		const body = src.slice(src.indexOf("export async function selectIacKnowledge"));
		expect(body).toContain("if (!config) return { selectedKnowledge: null };");
		// the catch block's fallback
		expect(body).toMatch(/catch[\s\S]*return \{ selectedKnowledge: null \};/);
		// and no bare `return {}` survives in the node
		expect(body).not.toMatch(/return \{\};/);
	});

	// Deliberately asserts only the tri-state invariant, NOT a specific category list. The node
	// reads the process-global agent via getAgentByName, and sibling suites register
	// mock.module("../prompt-context.ts") -- so whether the real config is visible depends on
	// file execution order (see reference_prompt_context_mock_pollutes_direct_imports). Under the
	// mock the node correctly takes its `!config` path and returns null; unmocked it returns the
	// converse set. Both are correct; asserting either specific value makes the test order-fragile
	// (it passed solo and across this directory, but failed in CI's full-monorepo run). The
	// category mapping itself is covered order-independently by the pure selectCategories tests.
	test("always writes the key -- never omits it, whichever path it takes", async () => {
		const result = await selectIacKnowledge({ intent: "converse" } as never);
		expect("selectedKnowledge" in result).toBe(true);
		const value = result.selectedKnowledge;
		expect(value === null || Array.isArray(value)).toBe(true);
		if (Array.isArray(value)) expect(value).toEqual([...DEFAULT_BY_INTENT.converse]);
	});

	test("TURN_START_RESET clears selectedKnowledge so a turn cannot inherit one", () => {
		// bootstrapIac spreads TURN_START_RESET on every turn; the field must be present and
		// null, or a turn that never reaches the selector keeps the last turn's narrowing.
		expect(TURN_START_RESET).toHaveProperty("selectedKnowledge", null);
	});

	test("an explicit null is a pass-through: full knowledge, not zero", () => {
		const agent = loadAgent(IAC_DIR);
		expect(filterAgentKnowledge(agent, null).knowledge.length).toBe(agent.knowledge.length);
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

// SIO-1289: OKF lifecycle exclusion for elastic-iac. SIO-1287 made `status: deprecated`
// binding for RUNBOOK selection; before this it did nothing for any other category, because
// stripFrontmatter discarded the parsed status. These pin the three carried-over decisions.
describe("OKF lifecycle exclusion (SIO-1289)", () => {
	// Typed against the real KnowledgeEntry rather than cast, so a change to the lifecycle
	// union is a compile error here instead of drifting silently.
	const entry = (filename: string, status?: KnowledgeEntry["status"], staleAfter?: string): KnowledgeEntry => ({
		category: "issues",
		filename,
		content: "body",
		status,
		staleAfter,
	});

	test("a deprecated entry is excluded", () => {
		const kept = excludeDeprecated([entry("a.md"), entry("b.md", "deprecated"), entry("c.md", "stable")]);
		expect(kept.map((e) => e.filename)).toEqual(["a.md", "c.md"]);
	});

	test("nothing deprecated is a pass-through preserving array identity", () => {
		const input = [entry("a.md", "stable"), entry("b.md")];
		expect(excludeDeprecated(input)).toBe(input);
	});

	test("draft and absent status are KEPT -- OKF defaults an absent status to stable", () => {
		const input = [entry("a.md", "draft"), entry("b.md")];
		expect(excludeDeprecated(input)).toBe(input);
	});

	test("ALL deprecated passes the full set through rather than starving the prompt", () => {
		const input = [entry("a.md", "deprecated"), entry("b.md", "deprecated")];
		expect(excludeDeprecated(input)).toBe(input);
	});

	test("a past stale_after is ADVISORY -- reported but never excluded", () => {
		const input = [entry("old.md", "stable", "2020-01-01"), entry("fresh.md", "stable", "2999-01-01")];
		expect(excludeDeprecated(input)).toBe(input);
		expect(staleEntries(input, new Date("2026-07-29"))).toEqual(["issues/old.md"]);
	});

	test("filterAgentKnowledge applies lifecycle BEFORE category selection", () => {
		const agent = loadAgent(IAC_DIR);
		const withDeprecated = {
			...agent,
			knowledge: agent.knowledge.map((k, i) => (i === 0 ? { ...k, status: "deprecated" as const } : k)),
		};
		const first = agent.knowledge[0];
		// selecting the deprecated entry's own category must still drop it
		const filtered = filterAgentKnowledge(withDeprecated, [first?.category as string]);
		expect(filtered.knowledge.some((k) => k.filename === first?.filename)).toBe(false);
	});
});
