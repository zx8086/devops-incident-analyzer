// gitagent-bridge/src/okf-spec-audit.test.ts
// SIO-1440: tier-1 static consistency checks over the OKF spec (agent.yaml/SOUL/RULES/knowledge)
// that the whole-pipeline eval program does not cover. See skill-tool-coverage.test.ts for the
// SIO-1228/1257/1229 checks this file deliberately does NOT duplicate.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { type LoadedAgent, loadAgent } from "./manifest-loader.ts";
import {
	findFrontmatterDegradations,
	findMissingDeclaredSubAgents,
	findOrphanedKnowledgeFiles,
	findSkillDeclarationDrift,
} from "./okf-spec-audit.ts";
import { type KnowledgeIndex, KnowledgeIndexSchema } from "./types.ts";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

// CodeRabbit (PR #630): the existing tests below verify the CURRENT repo state (already
// clean), which proves nothing about detection behavior -- a check that always returns []
// passes them too. These fixture-based tests build an isolated knowledge/ tree per case and
// assert the specific finding shape, matching the mkdtempSync convention used across this
// package's other *.test.ts files (see hooks.test.ts, memory.test.ts).
function makeKnowledgeFixture(indexYaml: KnowledgeIndex, files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "gitagent-okf-audit-test-"));
	mkdirSync(join(dir, "knowledge"), { recursive: true });
	writeFileSync(join(dir, "knowledge", "index.yaml"), JSON.stringify(indexYaml));
	for (const [relPath, content] of Object.entries(files)) {
		const filePath = join(dir, "knowledge", relPath);
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, content);
	}
	return dir;
}

describe("SIO-1440 check 2: knowledge frontmatter must not silently degrade", () => {
	test("every knowledge file's frontmatter parses cleanly (no tolerant-catch fallback)", () => {
		const indexYaml = parse(readFileSync(join(AGENTS_DIR, "knowledge/index.yaml"), "utf-8"));
		const index = KnowledgeIndexSchema.parse(indexYaml);
		const degradations = findFrontmatterDegradations(AGENTS_DIR, index);
		expect(degradations).toEqual([]);
	});

	test("a malformed frontmatter block IS reported, with category/filename/error", () => {
		const dir = makeKnowledgeFixture(
			{
				name: "fixture",
				description: "fixture",
				version: "0.1.0",
				categories: { "runbooks-general": { path: "general/runbooks/", description: "test" } },
			},
			{ "general/runbooks/broken.md": "---\ntype: [unterminated\n---\n\nbroken\n" },
		);
		const index = KnowledgeIndexSchema.parse(parse(readFileSync(join(dir, "knowledge/index.yaml"), "utf-8")));
		const degradations = findFrontmatterDegradations(dir, index);
		expect(degradations).toHaveLength(1);
		expect(degradations[0]?.category).toBe("runbooks-general");
		expect(degradations[0]?.filename).toBe("broken.md");
		expect(degradations[0]?.error.length).toBeGreaterThan(0);
	});

	test("well-formed frontmatter in a fixture is NOT reported (no false positive)", () => {
		const dir = makeKnowledgeFixture(
			{
				name: "fixture",
				description: "fixture",
				version: "0.1.0",
				categories: { "runbooks-general": { path: "general/runbooks/", description: "test" } },
			},
			{ "general/runbooks/ok.md": '---\ntype: Runbook\ntitle: "OK"\n---\n\nbody\n' },
		);
		const index = KnowledgeIndexSchema.parse(parse(readFileSync(join(dir, "knowledge/index.yaml"), "utf-8")));
		expect(findFrontmatterDegradations(dir, index)).toEqual([]);
	});
});

describe("SIO-1440 check 3: dead/orphan knowledge files in the spec tree", () => {
	test("every .md file under knowledge/ sits inside a declared category's path", () => {
		const indexYaml = parse(readFileSync(join(AGENTS_DIR, "knowledge/index.yaml"), "utf-8"));
		const index = KnowledgeIndexSchema.parse(indexYaml);
		const orphans = findOrphanedKnowledgeFiles(AGENTS_DIR, index);
		expect(orphans).toEqual([]);
	});

	test("a file in an undeclared subdirectory IS reported as orphaned", () => {
		const dir = makeKnowledgeFixture(
			{
				name: "fixture",
				description: "fixture",
				version: "0.1.0",
				categories: { "runbooks-general": { path: "general/runbooks/", description: "test" } },
			},
			{ "general/stray-dir/stray.md": "# stray\n" },
		);
		const index = KnowledgeIndexSchema.parse(parse(readFileSync(join(dir, "knowledge/index.yaml"), "utf-8")));
		const orphans = findOrphanedKnowledgeFiles(dir, index);
		expect(orphans).toEqual([{ path: "knowledge/general/stray-dir/stray.md" }]);
	});

	test("knowledge/index.md (the OKF bundle-root file) is exempted, not flagged", () => {
		const dir = makeKnowledgeFixture(
			{
				name: "fixture",
				description: "fixture",
				version: "0.1.0",
				categories: { "runbooks-general": { path: "general/runbooks/", description: "test" } },
			},
			{ "index.md": "---\nokf_version: 0.2\n---\n\n# bundle root\n" },
		);
		const index = KnowledgeIndexSchema.parse(parse(readFileSync(join(dir, "knowledge/index.yaml"), "utf-8")));
		expect(findOrphanedKnowledgeFiles(dir, index)).toEqual([]);
	});

	// CodeRabbit (PR #632): join() preserves a trailing backslash from a Windows-style
	// config.path (e.g. "general\\runbooks\\"), which the prior .replace(/\/$/, "") never
	// stripped -- declaredDirs.has(dir) would then never match on Windows, so every file in a
	// declared category would be misreported as orphaned. Not exercisable on macOS/Bun (no
	// backslash separators here), but the fix widens the character class at zero cost.
	test("a category path with a trailing backslash (Windows-style) is still recognized as declared", () => {
		const dir = makeKnowledgeFixture(
			{
				name: "fixture",
				description: "fixture",
				version: "0.1.0",
				categories: { "runbooks-general": { path: "general/runbooks\\", description: "test" } },
			},
			{ "general/runbooks/ok.md": "# ok\n" },
		);
		const index = KnowledgeIndexSchema.parse(parse(readFileSync(join(dir, "knowledge/index.yaml"), "utf-8")));
		expect(findOrphanedKnowledgeFiles(dir, index)).toEqual([]);
	});

	// CodeRabbit (PR #632): statSync() follows directory symlinks, so a self-referential
	// symlink under knowledge/ threw ELOOP and crashed the whole audit uncaught (reproduced
	// live: a "loop" -> "." symlink hit statSync's ELOOP within ~32 recursive calls). lstatSync()
	// identifies the link itself instead of following it, so the walk treats it as a leaf.
	test("a self-referential directory symlink does not crash the walk with ELOOP", () => {
		const dir = makeKnowledgeFixture(
			{
				name: "fixture",
				description: "fixture",
				version: "0.1.0",
				categories: { "runbooks-general": { path: "general/runbooks/", description: "test" } },
			},
			{ "general/runbooks/ok.md": "# ok\n" },
		);
		symlinkSync(".", join(dir, "knowledge", "general", "loop"), "dir");
		const index = KnowledgeIndexSchema.parse(parse(readFileSync(join(dir, "knowledge/index.yaml"), "utf-8")));
		expect(() => findOrphanedKnowledgeFiles(dir, index)).not.toThrow();
	});
});

function makeSkillFixture(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "gitagent-okf-audit-skill-"));
	for (const [relPath, content] of Object.entries(files)) {
		const filePath = join(dir, relPath);
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, content);
	}
	return dir;
}

describe("SIO-1444 check 4: skill-declaration drift, sub-agents included", () => {
	// index.test.ts's SIO-1281 test covers the ROOT incident-analyzer and elastic-iac skills/
	// dirs only. This walks the whole declared tree, so the sub-agent skill dirs
	// (capella/elastic/gitlab today) get the same guarantee. Iterates the manifest-declared
	// tree from loadAgent -- an UNDECLARED sub-agent directory is index.test.ts's own
	// "every sub-agent directory on disk is declared" concern, not re-checked here.
	test("no skill dir drifts from its agent.yaml declaration anywhere in the agent tree", () => {
		const flatten = (agent: LoadedAgent, dir: string): { agent: LoadedAgent; dir: string }[] => {
			const flat = [{ agent, dir }];
			for (const [subName, sub] of agent.subAgents) {
				flat.push(...flatten(sub, join(dir, "agents", subName)));
			}
			return flat;
		};
		const flat = flatten(loadAgent(AGENTS_DIR), AGENTS_DIR);

		// Anti-vacuity: the tree must actually reach sub-agent skill dirs, not just the root's.
		const withSkillsDir = flat.filter(({ dir }) => dir !== AGENTS_DIR && existsSync(join(dir, "skills")));
		expect(withSkillsDir.length).toBeGreaterThan(0);

		for (const { agent, dir } of flat) {
			expect(findSkillDeclarationDrift(dir, agent.manifest.skills ?? [])).toEqual([]);
			// CodeRabbit (PR #635): the flatten above iterates the LOADED subAgents map, which
			// cannot contain a declared child whose agent.yaml is missing -- loadAgent's
			// existsSync guard drops it silently. Check the DECLARED map against disk too, so
			// the walk itself is proven complete before its per-agent assertions mean anything.
			expect(findMissingDeclaredSubAgents(dir, Object.keys(agent.manifest.agents ?? {}))).toEqual([]);
		}
	});

	test("a declared sub-agent whose agent.yaml is missing IS reported", () => {
		const dir = makeSkillFixture({
			// Directory exists (so the on-disk-undeclared check would not see anything odd),
			// but the declared child has no agent.yaml -- loadAgent silently skips it.
			"agents/ghost-agent/SOUL.md": "# ghost\n",
		});
		expect(findMissingDeclaredSubAgents(dir, ["ghost-agent"])).toEqual([
			{ name: "ghost-agent", path: "agents/ghost-agent/agent.yaml" },
		]);
	});

	test("a declared sub-agent with agent.yaml present is NOT reported", () => {
		const dir = makeSkillFixture({
			"agents/real-agent/agent.yaml": 'spec_version: "0.1.0"\nname: real-agent\nversion: 0.1.0\ndescription: x\n',
		});
		expect(findMissingDeclaredSubAgents(dir, ["real-agent"])).toEqual([]);
	});

	test("an undeclared skills/<name>/ dir with a SKILL.md IS reported", () => {
		const dir = makeSkillFixture({
			"skills/stray-skill/SKILL.md": "---\nname: stray-skill\ndescription: x\n---\n\nbody\n",
		});
		expect(findSkillDeclarationDrift(dir, [])).toEqual([
			{ kind: "undeclared_skill_dir", name: "stray-skill", path: "skills/stray-skill" },
		]);
	});

	test("a declared skill with no SKILL.md IS reported", () => {
		const dir = makeSkillFixture({});
		expect(findSkillDeclarationDrift(dir, ["ghost-skill"])).toEqual([
			{ kind: "missing_skill_file", name: "ghost-skill", path: "skills/ghost-skill/SKILL.md" },
		]);
	});

	test("a declared skill with SKILL.md is clean; an undeclared dir without SKILL.md is ignored", () => {
		const dir = makeSkillFixture({
			"skills/real-skill/SKILL.md": "---\nname: real-skill\ndescription: x\n---\n\nbody\n",
			"skills/scratch/notes.txt": "not a skill\n",
		});
		expect(findSkillDeclarationDrift(dir, ["real-skill"])).toEqual([]);
	});

	test("an agent with no skills/ directory and no declared skills is clean", () => {
		const dir = mkdtempSync(join(tmpdir(), "gitagent-okf-audit-noskills-"));
		expect(findSkillDeclarationDrift(dir, [])).toEqual([]);
	});
});
