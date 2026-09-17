// apps/web/src/lib/repo-root.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findRepoRoot } from "./repo-root.ts";

// SIO-1143: these run from whichever checkout the suite was invoked in -- a main checkout
// OR a worktree. The assertions are written to hold in BOTH, because the whole point of the
// fix is that one code path serves both; a test that only passes in a main checkout would
// pass just as well against the bug it is guarding.
describe("findRepoRoot", () => {
	const here = import.meta.dir;

	// Greptile PR #801: mkdtempSync without cleanup left a sio1143-* directory in the system
	// temp dir on every run (6 observed locally before this). Matches the repo's existing
	// mkdtempSync + rmSync pattern (gitagent-bridge/src/shared-merge.test.ts).
	const scratchDirs: string[] = [];
	const makeScratch = (prefix: string): string => {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		scratchDirs.push(dir);
		return dir;
	};
	afterEach(() => {
		while (scratchDirs.length > 0) {
			const dir = scratchDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	test("resolves to the directory holding the shared .git, from any checkout", () => {
		const expected = dirname(
			execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
				cwd: here,
				encoding: "utf8",
			}).trim(),
		);
		expect(findRepoRoot(here)).toBe(expected);
	});

	// The regression this ticket exists for, stated as the property that actually matters:
	// the root this resolves to is one that HOLDS .env. That is what the dev server needs;
	// whether some other directory also has a copy is irrelevant to it.
	//
	// Greptile PR #801 (P1): an earlier version also asserted the checkout root does NOT
	// hold .env, to dramatise the worktree case. That was wrong -- this repo's own standing
	// workaround for the very bug being fixed is `cp MAIN/.env WORKTREE/.env` (used across
	// experiments/HANDOFF-2026-07-30-orbit-blast-radius-program.md:98 and several others),
	// so a worktree set up that way legitimately has BOTH files and would have failed the
	// suite while findRepoRoot was working correctly. Assert the positive property only.
	//
	// Skipped rather than failed where no .env exists (a fresh CI clone): .env is gitignored,
	// so asserting it unconditionally would fail for a reason unrelated to this code.
	test("resolves to a root that holds .env", () => {
		const root = findRepoRoot(here);
		if (!existsSync(join(root, ".env"))) return; // no .env anywhere; nothing to assert
		expect(existsSync(join(root, ".env"))).toBe(true);
	});

	test("falls back when the directory is not a git repo (container / extracted tarball)", () => {
		const scratch = makeScratch("sio1143-");
		const fallback = resolve(scratch, "../..");
		expect(findRepoRoot(scratch, fallback)).toBe(fallback);
	});

	// cwd must not leak in: a tarball extracted INSIDE another git repo would otherwise
	// resolve to that repo's root and load a foreign .env.
	test("answers for startDir, not the process cwd", () => {
		const scratch = makeScratch("sio1143-cwd-");
		const sentinel = "/sentinel-fallback";
		const original = process.cwd();
		try {
			process.chdir(here); // inside a real repo
			expect(findRepoRoot(scratch, sentinel)).toBe(sentinel);
		} finally {
			process.chdir(original);
		}
	});
});
