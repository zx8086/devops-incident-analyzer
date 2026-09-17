// apps/web/src/lib/repo-root.ts

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

// SIO-1143: the checkout root and the REPO root are the same directory only in a main
// checkout. In a git worktree the checkout root is <repo>/.claude/worktrees/<name>/, and
// the gitignored .env lives only in the main checkout -- so a worktree dev server that
// resolved env with `../..` silently loaded NOTHING. That is the environment trigger
// behind SIO-1142 (AWS_ESTATES unset -> awsTargetEstates: [] -> all 13 AWS tool calls
// threw the estate-scope guard), and it hit every env-gated feature the same way.
//
// --git-common-dir returns the ONE shared .git for a main checkout and every worktree
// alike, so its parent is the true repo root in both cases: one code path, no per-worktree
// ritual. `startDir` is passed explicitly (callers pass __dirname, never cwd) so the answer
// does not depend on where the process was invoked from -- an extracted tarball sitting
// inside some OTHER git repo must not resolve to that repo's root.
//
// The git call is deliberately NOT load-bearing. A container build or an extracted tarball
// has no .git, and may have no git binary at all; any failure returns `fallback`, which
// preserves the historical behavior exactly rather than regressing it.
export function findRepoRoot(startDir: string, fallback: string = resolve(startDir, "../..")): string {
	try {
		const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: startDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return commonDir ? dirname(commonDir) : fallback;
	} catch {
		return fallback;
	}
}
