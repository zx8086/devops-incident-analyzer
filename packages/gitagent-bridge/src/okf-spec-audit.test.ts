// gitagent-bridge/src/okf-spec-audit.test.ts
// SIO-1440: tier-1 static consistency checks over the OKF spec (agent.yaml/SOUL/RULES/knowledge)
// that the whole-pipeline eval program does not cover. See skill-tool-coverage.test.ts for the
// SIO-1228/1257/1229 checks this file deliberately does NOT duplicate.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { findFrontmatterDegradations, findOrphanedKnowledgeFiles } from "./okf-spec-audit.ts";
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
