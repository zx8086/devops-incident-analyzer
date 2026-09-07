// agent/src/iac/skill-selector-sync.test.ts
//
// SIO-1663, applying the SIO-1003 discipline that SIO-1285's knowledge-selector-sync test
// already applies to knowledge: WORKFLOW_TO_SKILL is a HAND-MAINTAINED mapping keyed on an
// enum, and every skill name in it is a STRING that must match a directory on disk. Both
// are exactly the shape of the bug SIO-1003 fixed. These tests pin the map to the enum in
// both directions, pin the names to the filesystem, and pin the invariants that are easy
// to "optimise" away.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt, loadAgent } from "@devops-agent/gitagent-bridge";
import {
	ALL_SKILLS,
	INFO_SKILLS,
	READ_ONLY_SKILLS,
	skillsForWorkflow,
	WORKFLOW_TO_SKILL,
	withShared,
} from "./skill-selector.ts";
import { WORKFLOW_VALUES } from "./state.ts";

const IAC_DIR = join(import.meta.dir, "../../../../agents/elastic-iac");

describe("skill selection enum sync (SIO-1663)", () => {
	test("WORKFLOW_TO_SKILL maps EVERY WORKFLOW_VALUES member", () => {
		for (const workflow of WORKFLOW_VALUES) {
			expect(WORKFLOW_TO_SKILL).toHaveProperty(workflow);
		}
	});

	test("WORKFLOW_TO_SKILL declares NOTHING extra (a renamed workflow cannot linger)", () => {
		const known: readonly string[] = WORKFLOW_VALUES;
		for (const key of Object.keys(WORKFLOW_TO_SKILL)) {
			expect(known).toContain(key);
		}
	});

	test("ALL_SKILLS matches the agent manifest exactly", () => {
		const declared = [...loadAgent(IAC_DIR).skills.keys()];
		const all: string[] = [...ALL_SKILLS];
		expect(all.sort()).toEqual(declared.sort());
	});

	test("every skill named by the map exists on disk", () => {
		for (const skill of Object.values(WORKFLOW_TO_SKILL)) {
			if (skill === null) continue;
			expect(existsSync(join(IAC_DIR, "skills", skill, "SKILL.md"))).toBe(true);
		}
	});

	test("every lane set names only real, manifest-declared skills", () => {
		const declared = new Set(loadAgent(IAC_DIR).skills.keys());
		for (const skill of [...READ_ONLY_SKILLS, ...INFO_SKILLS]) {
			expect(declared.has(skill)).toBe(true);
		}
	});

	// The load-bearing invariant, mirroring knowledge-selector-sync's "'info' is NEVER
	// narrowed". parseIntent returns "other" for anything it cannot place, so "other" is
	// not a category of request -- it is every novel, ambiguous or misclassified one.
	// Narrowing it would silently starve them all, with no error. This test exists so that
	// a future well-meaning prompt-cost optimisation fails CI instead of degrading judgment.
	test("'other' -- the classifier catch-all -- is NEVER narrowed", () => {
		expect(WORKFLOW_TO_SKILL.other).toBeNull();
		expect(skillsForWorkflow("other").sort()).toEqual([...ALL_SKILLS].sort());
	});

	test("a null workflow (parseIntent floor) is NEVER narrowed", () => {
		expect(skillsForWorkflow(null).sort()).toEqual([...ALL_SKILLS].sort());
		expect(skillsForWorkflow(undefined).sort()).toEqual([...ALL_SKILLS].sort());
	});

	test("a mapped workflow narrows to its skill plus the write-lane plumbing", () => {
		expect(skillsForWorkflow("tier-resize").sort()).toEqual(
			["open-mr", "resize-tier", "validate-cluster-state"].sort(),
		);
		expect(skillsForWorkflow("version-upgrade")).toContain("version-upgrade");
		expect(skillsForWorkflow("version-upgrade")).toContain("open-mr");
	});

	test("skillsForWorkflow never returns duplicates", () => {
		for (const workflow of WORKFLOW_VALUES) {
			const got = skillsForWorkflow(workflow);
			expect(got.length).toBe(new Set(got).size);
		}
	});

	// The read-only lanes bind INFO_TOOL_NAMES + kg_* + search_memory and physically cannot
	// branch or open an MR, so an edit skill there would promise a tool the lane cannot call.
	test("read-only lane sets contain no write skills", () => {
		for (const skill of [...READ_ONLY_SKILLS, ...INFO_SKILLS]) {
			expect(skill).not.toBe("open-mr");
		}
	});

	// SIO-1663: buildSystemPromptParts gates local AND shared skills on the same
	// activeSkills array, so any filter silently drops shared skills it does not name.
	// withShared is the guard; these tests pin both the bug and the fix.
	test("an unguarded filter DROPS shared skills (the bug withShared exists for)", () => {
		const agent = loadAgent(IAC_DIR);
		expect([...agent.sharedSkills.keys()].length).toBeGreaterThan(0);
		const unguarded = buildSystemPrompt(agent, [...ALL_SKILLS]);
		expect(unguarded).not.toContain("## Skill: cite-sources");
	});

	test("withShared re-adds every shared skill the agent loaded", () => {
		const agent = loadAgent(IAC_DIR);
		const guarded = buildSystemPrompt(agent, withShared(agent, ALL_SKILLS));
		for (const name of agent.sharedSkills.keys()) {
			expect(guarded).toContain(`## Skill: ${name}`);
		}
	});

	// The gate-off contract, mirroring SIO-1285's byte-identical invariant: selecting
	// EVERYTHING must reproduce today's unfiltered prompt exactly, so the wiring can never
	// change the prompt except by narrowing.
	test("full set + shared is BYTE-IDENTICAL to the unfiltered prompt", () => {
		const agent = loadAgent(IAC_DIR);
		expect(buildSystemPrompt(agent, withShared(agent, ALL_SKILLS))).toBe(buildSystemPrompt(agent));
	});

	test("withShared is idempotent and never duplicates", () => {
		const agent = loadAgent(IAC_DIR);
		const once = withShared(agent, ALL_SKILLS);
		const twice = withShared(agent, once);
		expect(twice).toEqual(once);
		expect(once.length).toBe(new Set(once).size);
	});

	test("a narrowed lane still carries the shared citation discipline", () => {
		const agent = loadAgent(IAC_DIR);
		const narrowed = buildSystemPrompt(agent, withShared(agent, skillsForWorkflow("tier-resize")));
		expect(narrowed).toContain("## Skill: cite-sources");
		expect(narrowed).toContain("## Skill: resize-tier");
		expect(narrowed).not.toContain("## Skill: edit-dashboard");
	});
});
