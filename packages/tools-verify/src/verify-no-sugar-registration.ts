// src/verify-no-sugar-registration.ts
// SIO-1413: SDK v2 removes the legacy sugar registration methods (server.tool /
// server.prompt / server.resource); the C-series sweep (SIO-1414..1421) converts
// every server to the register* config style. This guard makes each conversion
// STICK: a package removed from NOT_YET_CONVERTED below fails the build the
// moment a new sugar call lands in it, and the shrinking allowlist is the live
// to-do list for the remaining packages while the sweep is in flight.
//
// Note: packages/shared/src/cached-server-factory.ts deliberately KEEPS recording
// all six registration methods even after the sweep completes -- silently dropping
// a stray sugar registration at replay time is the SIO-1044 bug class this guard
// exists to prevent loudly, at CI time, instead.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(HERE, "../../..", "packages");

// Packages still using the legacy sugar API. Each C-series PR converts one server
// and deletes its entry here in the same commit. When the last entry goes, the
// guard enforces zero sugar registration repo-wide.
const NOT_YET_CONVERTED = new Set([
	"mcp-server-atlassian", // SIO-1416 (C-3)
	"mcp-server-aws", // SIO-1420 (C-7)
	"mcp-server-couchbase", // SIO-1419 (C-6)
	"mcp-server-elastic-iac", // SIO-1417 (C-4)
	"mcp-server-gitlab", // SIO-1418 (C-5)
	"mcp-server-kafka", // SIO-1421 (C-8)
	"mcp-server-knowledge-graph", // SIO-1415 (C-2)
]);
// mcp-server-elastic is absent: fully converted since SIO-1050 (v1.17.5 signature
// incompatibility forced it) -- it is the proof the guard passes on a converted tree.

// Live sugar call on a registration receiver, in dot or bracket form
// (server.tool( / server["tool"]( / server['tool']( -- CodeRabbit).
// `server.registerTool(` cannot match: after "server." the alternation must
// match at the first character, and "registerTool" does not start with "tool".
const SUGAR_CALL_RE = /\bserver(?:\.(?:tool|prompt|resource)|\[["'](?:tool|prompt|resource)["']\])\s*\(/g;

// Strip /* ... */ block comments and // line comments before matching -- elastic
// carries prose like "Direct server.tool() call" inside historical block comments,
// and conversion PRs leave "migrated from legacy server.tool()" line comments.
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n");
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry !== "__tests__" && entry !== "node_modules") walk(full, out);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts")) {
			out.push(full);
		}
	}
	return out;
}

function main(): void {
	const serverPackages = readdirSync(PACKAGES_DIR)
		.filter((entry) => entry.startsWith("mcp-server-"))
		.filter((entry) => statSync(join(PACKAGES_DIR, entry)).isDirectory());

	// A NOT_YET_CONVERTED entry naming a package that no longer exists is drift too.
	const unknownEntries = [...NOT_YET_CONVERTED].filter((name) => !serverPackages.includes(name));

	const counts = new Map<string, number>();
	for (const pkg of serverPackages) {
		let count = 0;
		for (const file of walk(join(PACKAGES_DIR, pkg, "src"))) {
			const stripped = stripComments(readFileSync(file, "utf8"));
			count += [...stripped.matchAll(SUGAR_CALL_RE)].length;
		}
		counts.set(pkg, count);
	}

	const violations = serverPackages.filter((pkg) => !NOT_YET_CONVERTED.has(pkg) && (counts.get(pkg) ?? 0) > 0);
	// A converted package (zero sugar calls) still listed in the allowlist is stale:
	// its C-series PR forgot to delete the entry, weakening the guard for that package.
	const stale = [...NOT_YET_CONVERTED].filter((pkg) => serverPackages.includes(pkg) && (counts.get(pkg) ?? 0) === 0);

	console.log(`Scanned ${serverPackages.length} mcp-server-* package(s) for legacy sugar registration calls.`);
	for (const pkg of serverPackages) {
		const marker = NOT_YET_CONVERTED.has(pkg) ? "pending conversion" : "converted";
		console.log(`  ${pkg}: ${counts.get(pkg)} call(s) [${marker}]`);
	}

	if (violations.length > 0) {
		console.error(`\n${violations.length} converted package(s) reintroduced sugar registration calls:\n`);
		for (const pkg of violations) {
			console.error(`  ${pkg}: ${counts.get(pkg)} call(s)`);
		}
		console.error(
			"\nUse server.registerTool/registerPrompt/registerResource (config-object style) instead -- SDK v2 removes the sugar methods (SIO-1413).",
		);
		process.exit(1);
	}

	if (stale.length > 0 || unknownEntries.length > 0) {
		for (const pkg of stale) {
			console.error(`\nStale NOT_YET_CONVERTED entry: ${pkg} has zero sugar calls -- remove it so the guard enforces.`);
		}
		for (const pkg of unknownEntries) {
			console.error(`\nUnknown NOT_YET_CONVERTED entry: ${pkg} is not a packages/mcp-server-* directory.`);
		}
		process.exit(1);
	}

	console.log(`\nNo sugar registration in converted packages; ${NOT_YET_CONVERTED.size} package(s) pending. OK.`);
}

main();
