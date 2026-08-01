// gitagent-bridge/src/skill-spec-compliance.test.ts
// SIO-1347: build-time agentskills.io spec gate over every SKILL.md in the repo.
// `bun run yaml:check` is yamllint over agents/ *.yaml files and cannot see .md
// frontmatter at all, and the runtime loader is deliberately tolerant, so this
// suite is the ONLY build-time guard on SKILL.md spec compliance. It also gates
// learn-lane skill-promotion PRs (SIO-1346): a generated SKILL.md merged into
// agents/ must pass here, which is the intended second gate after human review.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { validateSkillFile } from "./skill-spec-validator.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

// Scoped to exactly the two skill roots (agents/ recurses into shared and
// sub-agent skills/ dirs at every nesting depth; .agents/skills holds the
// operator skills) -- NOT the whole repo, so a stray SKILL.md in a scratch or
// vendor dir never silently joins the gate.
function findSkillFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry === "node_modules" || entry === ".git") continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
			} else if (entry === "SKILL.md") {
				out.push(full);
			}
		}
	};
	walk(root);
	return out;
}

const skillFiles = [
	...new Set([...findSkillFiles(join(REPO_ROOT, "agents")), ...findSkillFiles(join(REPO_ROOT, ".agents", "skills"))]),
].sort();

describe("validateSkillFile unit fixtures", () => {
	const path = "/repo/agents/example/skills/my-skill/SKILL.md";
	const valid = "---\nname: my-skill\ndescription: Does a thing. Use when the thing is needed.\n---\n\n# Body\n";

	test("accepts minimal spec-compliant frontmatter", () => {
		expect(validateSkillFile(path, valid)).toEqual([]);
	});

	test("accepts documented extension fields and spec optional fields", () => {
		const content = [
			"---",
			"name: my-skill",
			"description: Does a thing. Use when the thing is needed.",
			"license: MIT",
			"metadata:",
			"  audience: operators",
			"inputs:",
			"  cluster: { type: string, required: true }",
			"task_category: correlation",
			"learned_from: ticket:SIO-1",
			"usage_count: 3",
			"version: 1.0.0",
			"category: Agent Tooling",
			"---",
			"body",
		].join("\n");
		expect(validateSkillFile(path, content)).toEqual([]);
	});

	test("flags a file without frontmatter", () => {
		expect(validateSkillFile(path, "# Skill: My Skill\n")).toEqual([
			expect.objectContaining({ rule: "no-frontmatter" }),
		]);
	});

	test("flags a missing closing delimiter", () => {
		expect(validateSkillFile(path, "---\nname: my-skill\n")).toEqual([
			expect.objectContaining({ rule: "no-frontmatter" }),
		]);
	});

	test("flags malformed YAML", () => {
		expect(validateSkillFile(path, "---\nname: [unclosed\n---\n")).toEqual([
			expect.objectContaining({ rule: "frontmatter-parse-error" }),
		]);
	});

	test("flags missing name and description on empty frontmatter", () => {
		const rules = validateSkillFile(path, "---\n---\nbody\n").map((v) => v.rule);
		expect(rules).toEqual(["name-required", "description-required"]);
	});

	test("flags name format violations", () => {
		for (const bad of ["My-Skill", "-my-skill", "my-skill-", "my--skill", "my_skill"]) {
			const content = `---\nname: "${bad}"\ndescription: d\n---\n`;
			expect(validateSkillFile(path, content).map((v) => v.rule)).toContain("name-format");
		}
	});

	test("flags a name longer than 64 chars", () => {
		const long = "a".repeat(65);
		const content = `---\nname: ${long}\ndescription: d\n---\n`;
		expect(validateSkillFile(`/repo/skills/${long}/SKILL.md`, content).map((v) => v.rule)).toContain("name-too-long");
	});

	test("flags a name that does not match the parent directory", () => {
		const content = "---\nname: other-name\ndescription: d\n---\n";
		expect(validateSkillFile(path, content).map((v) => v.rule)).toContain("name-mismatch");
	});

	test("flags an empty and an oversize description", () => {
		const empty = '---\nname: my-skill\ndescription: "  "\n---\n';
		expect(validateSkillFile(path, empty).map((v) => v.rule)).toContain("description-required");
		const oversize = `---\nname: my-skill\ndescription: ${"x".repeat(1025)}\n---\n`;
		expect(validateSkillFile(path, oversize).map((v) => v.rule)).toContain("description-too-long");
	});

	test("flags unknown top-level fields", () => {
		const content = "---\nname: my-skill\ndescription: d\nargument-hint: nope\n---\n";
		const violations = validateSkillFile(path, content);
		expect(violations.map((v) => v.rule)).toEqual(["unknown-field"]);
		expect(violations[0]?.detail).toContain("argument-hint");
	});
});

describe("SKILL.md spec compliance (agents/ and .agents/skills)", () => {
	// Canary against a discovery regression: a broken walk that finds zero files
	// would otherwise pass an empty for-loop below. 31 = the 29 gitagent skills +
	// 2 operator skills at the time of SIO-1347; new skills (including learn-lane
	// promotions) only raise this number.
	test("discovers the full skill corpus", () => {
		expect(skillFiles.length).toBeGreaterThanOrEqual(31);
	});

	for (const file of skillFiles) {
		test(`${relative(REPO_ROOT, file)} is spec-compliant`, () => {
			const violations = validateSkillFile(file, readFileSync(file, "utf-8"));
			expect(violations).toEqual([]);
		});
	}
});
