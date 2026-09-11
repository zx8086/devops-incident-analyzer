// scripts/verify-agentcore-manifests.ts
// SIO-852: Dockerfile.agentcore hand-lists one COPY per workspace manifest so the
// frozen lockfile validates. A workspace added without its COPY line fails the
// shared deps stage for EVERY server, not just the one being built:
//   error: workspace "@devops-agent/agent" depends on workspace
//   "@devops-agent/pi-coms" (packages/pi-coms), which is listed in bun.lock but
//   not on disk
// That is a slow, confusing failure to hit at deploy time, so catch it in CI.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const dockerfile = "Dockerfile.agentcore";

// Mirrors the root package.json `workspaces.packages` globs (packages/*, apps/*).
// Derived from disk rather than hardcoded -- a second hand-kept list would just
// reintroduce the drift this guard exists to catch.
const workspaceGlobRoots = ["packages", "apps"];

function workspaceDirs(): string[] {
	const found: string[] = [];
	for (const root of workspaceGlobRoots) {
		const rootPath = join(repoRoot, root);
		let entries: string[];
		try {
			entries = readdirSync(rootPath);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const dir = join(rootPath, entry);
			if (!statSync(dir).isDirectory()) continue;
			try {
				statSync(join(dir, "package.json"));
			} catch {
				continue; // a directory without a manifest is not a workspace
			}
			found.push(`${root}/${entry}`);
		}
	}
	return found.sort();
}

function copiedManifests(dockerfileText: string): Set<string> {
	const copied = new Set<string>();
	// Matches: COPY packages/<name>/package.json packages/<name>/
	const re = /^\s*COPY\s+((?:packages|apps)\/[^/\s]+)\/package\.json\s/gm;
	for (const match of dockerfileText.matchAll(re)) {
		copied.add(match[1]);
	}
	return copied;
}

const dockerfileText = readFileSync(join(repoRoot, dockerfile), "utf8");
const expected = workspaceDirs();
const actual = copiedManifests(dockerfileText);

const missing = expected.filter((dir) => !actual.has(dir));
// A COPY for a workspace that no longer exists breaks the build just as hard,
// since COPY fails on a missing source path.
const stale = [...actual].filter((dir) => !expected.includes(dir)).sort();

if (missing.length === 0 && stale.length === 0) {
	console.log(`${dockerfile}: all ${expected.length} workspace manifests have a COPY line`);
	process.exit(0);
}

if (missing.length > 0) {
	console.error(`${dockerfile} is missing a COPY line for ${missing.length} workspace manifest(s):\n`);
	for (const dir of missing) {
		console.error(`  COPY ${dir}/package.json ${dir}/`);
	}
	console.error("\nAdd the line(s) above to the deps stage. Without them, `bun install");
	console.error("--frozen-lockfile` fails for every server built from this Dockerfile.");
}

if (stale.length > 0) {
	console.error(`\n${dockerfile} COPIes ${stale.length} manifest(s) that no longer exist:\n`);
	for (const dir of stale) {
		console.error(`  ${dir}/package.json`);
	}
	console.error("\nRemove the line(s) above; COPY fails on a missing source.");
}

process.exit(1);
