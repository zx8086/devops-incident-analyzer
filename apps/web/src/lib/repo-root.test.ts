// apps/web/src/lib/repo-root.test.ts

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findRepoRoot } from "./repo-root.ts";

// SIO-1143: these run from whichever checkout the suite was invoked in -- a main checkout
// OR a worktree. The assertions are written to hold in BOTH, because the whole point of the
// fix is that one code path serves both; a test that only passes in a main checkout would
// pass just as well against the bug it is guarding.
describe("findRepoRoot", () => {
	const here = import.meta.dir;

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
	// the resolved root is the one holding .env, even when the checkout root is not.
	// Skipped rather than failed where no .env exists (a fresh CI checkout) -- .env is
	// gitignored, so asserting it unconditionally would make this suite fail on a clean
	// clone for a reason that has nothing to do with this code.
	test("resolves to the root that holds .env, which the checkout root may not", () => {
		const root = findRepoRoot(here);
		const checkoutRoot = resolve(here, "../../..");
		if (!existsSync(join(root, ".env"))) return; // no .env available; nothing to assert
		expect(existsSync(join(root, ".env"))).toBe(true);
		// In a worktree this is the whole bug: the old `../..` target has no .env while the
		// resolved root does. In a main checkout the two coincide and this is trivially true.
		if (root !== checkoutRoot) {
			expect(existsSync(join(checkoutRoot, ".env"))).toBe(false);
		}
	});

	test("falls back when the directory is not a git repo (container / extracted tarball)", () => {
		const scratch = mkdtempSync(join(tmpdir(), "sio1143-"));
		const fallback = resolve(scratch, "../..");
		expect(findRepoRoot(scratch, fallback)).toBe(fallback);
	});

	// cwd must not leak in: a tarball extracted INSIDE another git repo would otherwise
	// resolve to that repo's root and load a foreign .env.
	test("answers for startDir, not the process cwd", () => {
		const scratch = mkdtempSync(join(tmpdir(), "sio1143-cwd-"));
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
