// agent/src/skill-manifest.test.ts
import { describe, expect, test } from "bun:test";
import { addSkillToManifest, manifestHasSkill } from "./skill-manifest.ts";

const PLAIN = `name: incident-analyzer
version: "1.0.0"
description: test

# hand-curated list
skills:
  - normalize-incident
  - aggregate-findings

tools:
  - elastic-logs
`;

const ID_DIALECT = `name: elastic-iac
version: "1.0.0"
description: test
skills:
  - id: version-upgrade
  - id: resize-tier
tools: []
`;

describe("manifestHasSkill (SIO-1345)", () => {
	test("finds plain-dialect entries", () => {
		expect(manifestHasSkill(PLAIN, "normalize-incident")).toBe(true);
		expect(manifestHasSkill(PLAIN, "missing")).toBe(false);
	});
	test("finds id-dialect entries", () => {
		expect(manifestHasSkill(ID_DIALECT, "resize-tier")).toBe(true);
		expect(manifestHasSkill(ID_DIALECT, "missing")).toBe(false);
	});
	test("false on unparseable or listless yaml", () => {
		expect(manifestHasSkill("not: [valid", "x")).toBe(false);
		expect(manifestHasSkill("name: a\n", "x")).toBe(false);
	});
});

describe("addSkillToManifest (SIO-1345)", () => {
	test("appends to a plain-dialect block, preserving everything else byte-for-byte", () => {
		const { content, changed } = addSkillToManifest(PLAIN, "lag-correlation");
		expect(changed).toBe(true);
		expect(content).toBe(PLAIN.replace("  - aggregate-findings\n", "  - aggregate-findings\n  - lag-correlation\n"));
	});
	test("appends in id dialect when the block uses id entries", () => {
		const { content } = addSkillToManifest(ID_DIALECT, "new-skill");
		expect(content).toContain("  - id: resize-tier\n  - id: new-skill\n");
	});
	test("idempotent when the skill is already listed", () => {
		const { content, changed } = addSkillToManifest(PLAIN, "aggregate-findings");
		expect(changed).toBe(false);
		expect(content).toBe(PLAIN);
	});
	test("inserts right after the header when the block is empty", () => {
		const empty = 'name: a\nversion: "1"\ndescription: d\nskills:\ntools: []\n';
		const { content } = addSkillToManifest(empty, "first");
		expect(content).toContain("skills:\n  - first\ntools: []");
	});
	test("throws when there is no skills key", () => {
		expect(() => addSkillToManifest('name: a\nversion: "1"\ndescription: d\n', "x")).toThrow(/skills/);
	});
});
