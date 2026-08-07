// packages/agent/src/eval/coverage-targets.ts
//
// SIO-1398: the mcp-tool-eval coverage target, DERIVED from the repo's own deterministic
// sources rather than hand-listed. Hand-picking tools was the original weakness -- the first
// sweep exercised 23 of ~341 declared tools with no principled reason for those 23.
//
// Three sources, unioned. Each answers "which tools does this repo already say matter?":
//
//   1. Runbook `tools:` frontmatter -- tools a human authored an incident procedure around.
//      Parsed with the repo's OWN helpers (extractFrontmatterTools, falling back to
//      extractTailSection) so this cannot drift from what runbook-validator enforces.
//   2. TYPED_FINDING_TOOLS -- feed typed extractors. Extractors dispatch on exact
//      `toolName ===` equality, so a tool here that never fires means a findings card
//      silently renders empty.
//   3. RESOLUTION_TOOLS_BY_DATASOURCE -- force-included in EVERY action selection, i.e. the
//      repo declaring these must always be reachable.
//
// Deliberately NOT sourced from: the full action_tool_map (341 names -- breadth without
// signal, and many are write tools an eval must never call), couchbase playbooks (server-side
// only, no in-repo tool list), and skillflow presets (they name skills, not MCP tools).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { extractFrontmatterTools, extractTailSection, isRunbookCategory } from "@devops-agent/gitagent-bridge";
import { ORBIT_TOOL_NAMES } from "../correlation/extractors/orbit.ts";
import { getAgentsDir } from "../paths.ts";
import { RESOLUTION_TOOLS_BY_DATASOURCE } from "../sub-agent.ts";
import { TYPED_FINDING_TOOLS } from "../sub-agent-instrumentation.ts";

export type CoverageSource = "runbook" | "typed-finding" | "resolution" | "orbit";

export interface CoverageTarget {
	toolName: string;
	dataSource: string;
	// Every source that names this tool. A tool cited by more than one source is more
	// load-bearing, so this doubles as the priority signal.
	sources: CoverageSource[];
	// Runbooks citing it, for traceability back to the procedure that motivated coverage.
	runbooks: string[];
}

// Tool-name prefix -> datasource id. Runbooks are cross-datasource by design (a single
// incident procedure spans kafka + elastic + couchbase), so the datasource comes from the
// tool name, never the file name.
const PREFIX_TO_DATASOURCE: [RegExp, string][] = [
	[/^elasticsearch_/, "elastic"],
	[/^(kafka_|ksql_|connect_|sr_|schema_registry)/, "kafka"],
	[/^capella_/, "couchbase"],
	[/^gitlab_/, "gitlab"],
	[/^aws_/, "aws"],
	[/^konnect_/, "konnect"],
	[/^atlassian_/, "atlassian"],
];

// findLinkedIncidents / getIncidentHistory / getRunbookForAlert are the atlassian MCP's custom
// tools and carry no prefix, so they are mapped explicitly.
const UNPREFIXED_DATASOURCE: Record<string, string> = {
	findLinkedIncidents: "atlassian",
	getIncidentHistory: "atlassian",
	getRunbookForAlert: "atlassian",
};

export function datasourceForTool(toolName: string): string {
	const explicit = UNPREFIXED_DATASOURCE[toolName];
	if (explicit) return explicit;
	for (const [pattern, ds] of PREFIX_TO_DATASOURCE) {
		if (pattern.test(toolName)) return ds;
	}
	return "unknown";
}

// Resolves the set of runbook directories to scan. Runbooks now live in per-datasource
// subfolders (runbooks/aws/, runbooks/kafka/, ...), each its own registered category in
// knowledge/index.yaml (see isRunbookCategory). Falls back to treating runbookDir itself
// as a single flat directory when no index.yaml/categories are found there, so passing a
// synthetic flat directory (e.g. in a test) still works.
function resolveRunbookDirs(runbookDir: string): string[] {
	const knowledgeDir = join(runbookDir, "..");
	const indexPath = join(knowledgeDir, "index.yaml");
	if (!existsSync(indexPath)) return [runbookDir];

	let parsed: unknown;
	try {
		parsed = parse(readFileSync(indexPath, "utf-8"));
	} catch {
		return [runbookDir];
	}
	const categories = (parsed as { categories?: Record<string, { path?: string }> } | undefined)?.categories;
	if (!categories) return [runbookDir];

	const dirs = Object.entries(categories)
		.filter(([category]) => isRunbookCategory(category))
		.map(([, config]) => config.path)
		.filter((p): p is string => typeof p === "string")
		.map((p) => join(knowledgeDir, p));

	return dirs.length > 0 ? dirs : [runbookDir];
}

// Reads every runbook's declared tool list. Frontmatter `tools:` is authoritative when
// present; extractTailSection is the documented fallback (SIO-1288's dual-read), matching
// runbook-validator's own precedence exactly.
export function runbookToolCitations(
	runbookDir: string = join(getAgentsDir("incident-analyzer"), "knowledge/runbooks"),
): Map<string, string[]> {
	const byRunbook = new Map<string, string[]>();
	for (const dir of resolveRunbookDirs(runbookDir)) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
			const content = readFileSync(join(dir, file), "utf-8");
			const tools = extractFrontmatterTools(content) ?? extractTailSection(content).citations.map((c) => c.name);
			if (tools.length > 0) byRunbook.set(file.replace(/\.md$/, ""), tools);
		}
	}
	return byRunbook;
}

export function buildCoverageTargets(runbookDir?: string): CoverageTarget[] {
	const merged = new Map<string, CoverageTarget>();

	const add = (toolName: string, source: CoverageSource, runbook?: string): void => {
		const existing = merged.get(toolName);
		if (existing) {
			if (!existing.sources.includes(source)) existing.sources.push(source);
			if (runbook && !existing.runbooks.includes(runbook)) existing.runbooks.push(runbook);
			return;
		}
		merged.set(toolName, {
			toolName,
			dataSource: datasourceForTool(toolName),
			sources: [source],
			runbooks: runbook ? [runbook] : [],
		});
	};

	for (const [runbook, tools] of runbookToolCitations(runbookDir)) {
		for (const tool of tools) add(tool, "runbook", runbook);
	}
	// CodeRabbit (PR #599): these were unioned into one "typed-finding" loop, which recorded
	// every Orbit tool under the wrong provenance and would give a misleading priority signal the
	// moment the two sets diverge. Separate loops, correct source each.
	for (const tool of TYPED_FINDING_TOOLS) add(tool, "typed-finding");
	for (const tool of ORBIT_TOOL_NAMES) add(tool, "orbit");
	for (const tools of Object.values(RESOLUTION_TOOLS_BY_DATASOURCE)) {
		for (const tool of tools) add(tool, "resolution");
	}

	return [...merged.values()].sort((a, b) =>
		a.dataSource === b.dataSource ? a.toolName.localeCompare(b.toolName) : a.dataSource.localeCompare(b.dataSource),
	);
}

export function coverageTargetsByDatasource(runbookDir?: string): Map<string, CoverageTarget[]> {
	const byDs = new Map<string, CoverageTarget[]>();
	for (const target of buildCoverageTargets(runbookDir)) {
		byDs.set(target.dataSource, [...(byDs.get(target.dataSource) ?? []), target]);
	}
	return byDs;
}

export interface CoverageReport {
	total: number;
	covered: number;
	missing: CoverageTarget[];
	byDatasource: Map<string, { total: number; covered: number; missing: string[] }>;
}

// Diffs the derived targets against a set of tool names actually exercised. `exercised` comes
// from a live run's trajectories (tool-trajectory.ts), so this reports real coverage rather
// than declared intent.
export function reportCoverage(exercised: ReadonlySet<string>, runbookDir?: string): CoverageReport {
	const targets = buildCoverageTargets(runbookDir);
	const byDatasource = new Map<string, { total: number; covered: number; missing: string[] }>();
	const missing: CoverageTarget[] = [];

	for (const target of targets) {
		const entry = byDatasource.get(target.dataSource) ?? { total: 0, covered: 0, missing: [] };
		entry.total++;
		if (exercised.has(target.toolName)) {
			entry.covered++;
		} else {
			entry.missing.push(target.toolName);
			missing.push(target);
		}
		byDatasource.set(target.dataSource, entry);
	}

	return { total: targets.length, covered: targets.length - missing.length, missing, byDatasource };
}
