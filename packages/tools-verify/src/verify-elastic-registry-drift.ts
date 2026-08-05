// src/verify-elastic-registry-drift.ts
// SIO-1388: every tool file under mcp-server-elastic/src/tools/** must be either registered in
// tools/index.ts or listed in KNOWN_UNREGISTERED below WITH A STATED REASON.
//
// Why this exists: 27 fully-implemented tools sat commented out of the registry since the file's
// creation commit, carrying no explanation. They kept passing typecheck, lint, and biome, and were
// maintained by later refactors (SIO-671, SIO-673, SIO-1047) -- so nothing ever surfaced the fact
// that they were unreachable. A reader could not tell "deliberately parked" from "rotted". This
// check turns that silent state into a declared, reviewed inventory, and fails the build when a NEW
// tool file goes unregistered without a decision being recorded.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ELASTIC_SRC = join(HERE, "../../mcp-server-elastic/src");
const TOOLS_DIR = join(ELASTIC_SRC, "tools");
// TWO registries, not one: tools/index.ts registers the ~96 cluster tools, and server.ts registers
// the 16 Elastic Cloud + Billing tools separately (they take a CloudClient, not the ES Client, and
// are conditional on EC_API_KEY). Scanning only the former would report all 16 as unregistered.
const REGISTRIES = [join(TOOLS_DIR, "index.ts"), join(ELASTIC_SRC, "server.ts")];

// Deliberately-unregistered tool files, each with the reason it stays parked. Keep in sync with the
// PARKED comment blocks in tools/index.ts -- those explain the decision, this makes it checkable.
const KNOWN_UNREGISTERED: Record<string, string> = {
	"watcher/": "PARKED: 13 tools = half the 25-tool agent budget; read subset is the re-enable candidate (SIO-1388)",
	"enrich/": "PARKED: data-ingest concern, not incident analysis; kept by SIO-1047's dead-code review",
	"autoscaling/": "PARKED: capacity is managed via the Elastic Cloud tools on our deployments",
	"analytics/": "PARKED: term vectors are relevance debugging; timestamp analysis duplicates a date_histogram agg",
	"tasks/cancel_task.ts": "PARKED: write op -- needs readOnlyMode.ts name-set treatment before enabling",
};

// Files that are not tools: shared helpers, type declarations, and the registry itself.
const NON_TOOL_FILE = /(^|\/)(index|types|shared|helpers|constants|schemas|utils|errors)\.ts$/;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

function parkedReasonFor(relPath: string): string | undefined {
	for (const [pattern, reason] of Object.entries(KNOWN_UNREGISTERED)) {
		if (pattern.endsWith("/") ? relPath.startsWith(pattern) : relPath === pattern) return reason;
	}
	return undefined;
}

function main(): void {
	// A registration is live only when the call is NOT commented out. Strip line comments first so a
	// `// registerFooTool(server, esClient);` never counts as registered -- that is the exact failure
	// mode this check exists to catch.
	const liveRegistry = REGISTRIES.map((path) =>
		readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("//"))
			.join("\n"),
	).join("\n");

	const unregistered: Array<{ file: string; exports: string[] }> = [];
	const parked: Array<{ file: string; reason: string }> = [];

	for (const file of walk(TOOLS_DIR)) {
		// CodeRabbit (PR #595): normalize to POSIX separators. On Windows `relative()` yields
		// "watcher\get_watch.ts", which matches neither the "watcher/" allowlist prefix nor the
		// NON_TOOL_FILE regex -- so parked tools would be reported as undeclared drift and helper
		// files would stop being excluded. Verified both fail without this.
		const relPath = relative(TOOLS_DIR, file).split(sep).join("/");
		if (NON_TOOL_FILE.test(relPath)) continue;

		const source = readFileSync(file, "utf8");
		const exported = [...source.matchAll(/export const (register\w+Tool)/g)].map((m) => m[1] as string);
		if (exported.length === 0) continue;

		const isRegistered = exported.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(liveRegistry));
		if (isRegistered) continue;

		const reason = parkedReasonFor(relPath);
		if (reason) parked.push({ file: relPath, reason });
		else unregistered.push({ file: relPath, exports: exported });
	}

	// Stale allowlist entries are also drift: a parked file that got registered (or deleted) should
	// not keep an entry claiming otherwise.
	const staleAllowlist = Object.keys(KNOWN_UNREGISTERED).filter(
		(pattern) => !parked.some((p) => (pattern.endsWith("/") ? p.file.startsWith(pattern) : p.file === pattern)),
	);

	console.log(`Scanned ${walk(TOOLS_DIR).length} file(s) under mcp-server-elastic/src/tools.`);
	console.log(`${parked.length} deliberately parked (declared in KNOWN_UNREGISTERED).`);

	if (unregistered.length > 0) {
		console.error(`\n${unregistered.length} tool file(s) are neither registered nor declared as parked:\n`);
		for (const u of unregistered) {
			console.error(`  ${u.file} -> ${u.exports.join(", ")}`);
		}
		console.error(
			"\nRegister them in src/tools/index.ts, or add a KNOWN_UNREGISTERED entry stating WHY they stay parked.",
		);
		process.exit(1);
	}

	if (staleAllowlist.length > 0) {
		console.error(`\n${staleAllowlist.length} stale KNOWN_UNREGISTERED entr(ies) -- now registered or deleted:\n`);
		for (const pattern of staleAllowlist) {
			console.error(`  ${pattern}`);
		}
		console.error("\nRemove these entries so the allowlist keeps describing reality.");
		process.exit(1);
	}

	console.log("\nElastic tool registry has no undeclared drift. OK.");
}

main();
