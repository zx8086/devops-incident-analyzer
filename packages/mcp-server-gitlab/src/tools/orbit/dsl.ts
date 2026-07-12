// src/tools/orbit/dsl.ts
//
// Pure builders for the GitLab Orbit query DSL. All DSL construction lives here
// so the Beta query language is a single-file fix on drift. Each builder returns
// { queryTag, dsl }: the tag is a stable discriminator the Layer-B extractor
// branches on; the dsl is the object POSTed to /orbit/query.
//
// Correctness rules encoded here (from the Orbit query-language reference):
//  - SELECTIVITY IS MANDATORY: every query carries a full_path / time / node_ids
//    filter. An unbounded scan is rejected server-side (and still billable).
//  - LIMITS: <=5 nodes, <=5 relationships, <=3 hops, limit <= 1000.
//  - Pipeline queries MUST filter source = "merge_request_event", else parent/
//    child fan-out over-counts and won't match the MR Pipelines tab.
//  - MR history uses HAS_DIFF (all snapshots), NOT HAS_LATEST_DIFF (undercounts).
//  - File identity uses MergeRequestDiffFile.old_path (stable across renames).
//  - Text-indexed props only: Definition.{fqn,name,file_path},
//    ImportedSymbol.{file_path,import_path} -- use token_match/any_tokens there.

import type { OrbitQuery } from "../../gitlab-client/orbit.js";

export const ORBIT_QUERY_TAGS = {
	blastRadius: "orbit_blast_radius",
	crossProjectCallers: "orbit_cross_project_callers",
	recentDeploys: "orbit_recent_deploys",
	pipelineFailures: "orbit_pipeline_failures",
	recentVulnerabilities: "orbit_recent_vulnerabilities",
} as const;

export type OrbitQueryTag = (typeof ORBIT_QUERY_TAGS)[keyof typeof ORBIT_QUERY_TAGS];

export interface TaggedOrbitQuery {
	queryTag: OrbitQueryTag;
	dsl: OrbitQuery;
}

const MAX_LIMIT = 1000;
const PIPELINE_SOURCE_FILTER = { op: "eq", value: "merge_request_event" } as const;

function clampLimit(limit: number | undefined, fallback: number): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return fallback;
	return Math.min(MAX_LIMIT, Math.trunc(limit));
}

// Reject an empty selector so a builder never emits an unbounded (rejected,
// billable) query. Callers pass an already-non-empty anchor; this is a guard.
function requireSelector(value: string, field: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`Orbit query requires a non-empty ${field} for selectivity`);
	return trimmed;
}

// SIO-1076: Orbit rejects a query with no selective node (a filter / node_ids /
// id_range on at least one node), but still bills for it. The purpose-built
// builders guarantee selectivity; the raw escape hatch must validate the LLM's
// query BEFORE the billed call. A node is selective if it carries any of those.
export function hasSelectiveAnchor(query: OrbitQuery): boolean {
	const nodes: unknown[] = [];
	if (Array.isArray(query.nodes)) nodes.push(...query.nodes);
	if (query.node) nodes.push(query.node);
	return nodes.some((n) => {
		if (!n || typeof n !== "object") return false;
		const rec = n as Record<string, unknown>;
		const filters = rec.filters;
		const hasFilters = !!filters && typeof filters === "object" && Object.keys(filters).length > 0;
		return hasFilters || rec.node_ids !== undefined || rec.id_range !== undefined;
	});
}

// Blast radius: a changed Definition (by symbol) and the cross-project files that
// IMPORT it. Anchored on the symbol name (text-indexed) for selectivity.
// Definition -[DEFINES]- File -[IN_PROJECT]- Project (source side); the importer
// side is resolved via ImportedSymbol whose import_path/identifier matches.
export function buildBlastRadiusQuery(params: {
	symbol: string;
	groupPath?: string;
	limit?: number;
}): TaggedOrbitQuery {
	const symbol = requireSelector(params.symbol, "symbol");
	const importFilter: Record<string, unknown> = {
		// text-indexed on ImportedSymbol.import_path
		import_path: { op: "any_tokens", value: symbol },
	};
	if (params.groupPath) {
		importFilter.file_path = { op: "contains", value: params.groupPath };
	}
	return {
		queryTag: ORBIT_QUERY_TAGS.blastRadius,
		dsl: {
			query_type: "traversal",
			nodes: [
				{
					id: "def",
					entity: "Definition",
					columns: ["name", "fqn", "file_path", "definition_type", "start_line", "end_line"],
					// text-indexed on Definition.name for selectivity
					filters: { name: { op: "token_match", value: symbol } },
				},
				{
					id: "sym",
					entity: "ImportedSymbol",
					columns: ["file_path", "import_path", "identifier_name"],
					filters: importFilter,
				},
			],
			relationships: [{ type: "IMPORTS", from: "sym", to: "def" }],
			limit: clampLimit(params.limit, 200),
		},
	};
}

// Cross-project callers of a fully-qualified definition. Uses the exact fqn
// (text-indexed) for a precise anchor.
export function buildCrossProjectCallersQuery(params: { fqn: string; limit?: number }): TaggedOrbitQuery {
	const fqn = requireSelector(params.fqn, "fqn");
	return {
		queryTag: ORBIT_QUERY_TAGS.crossProjectCallers,
		dsl: {
			query_type: "traversal",
			nodes: [
				{
					id: "def",
					entity: "Definition",
					columns: ["name", "fqn", "file_path"],
					filters: { fqn: { op: "eq", value: fqn } },
				},
				{
					id: "sym",
					entity: "ImportedSymbol",
					columns: ["file_path", "import_path", "identifier_name"],
				},
			],
			relationships: [{ type: "IMPORTS", from: "sym", to: "def" }],
			limit: clampLimit(params.limit, 200),
		},
	};
}

// Recent deploy MRs across a group, merged since a timestamp. Selectivity via the
// group full_path prefix + the merged_at time bound.
export function buildRecentDeploysQuery(params: {
	groupPath: string;
	since: string;
	limit?: number;
}): TaggedOrbitQuery {
	const groupPath = requireSelector(params.groupPath, "groupPath");
	const since = requireSelector(params.since, "since");
	return {
		queryTag: ORBIT_QUERY_TAGS.recentDeploys,
		dsl: {
			query_type: "traversal",
			nodes: [
				{
					id: "p",
					entity: "Project",
					columns: ["name", "full_path"],
					filters: { full_path: { op: "starts_with", value: `${groupPath}/` } },
				},
				{
					id: "mr",
					entity: "MergeRequest",
					columns: ["iid", "id", "title", "state", "merged_at", "target_branch"],
					filters: {
						state: { op: "eq", value: "merged" },
						merged_at: { op: "gte", value: since },
					},
				},
			],
			relationships: [{ type: "IN_PROJECT", from: "mr", to: "p" }],
			order_by: { node: "mr", property: "merged_at", direction: "DESC" },
			limit: clampLimit(params.limit, 50),
		},
	};
}

// Ranked pipeline failures across a group in a time window. Aggregation grouped by
// project + job name. MUST filter source = merge_request_event (see header).
export function buildPipelineFailuresQuery(params: {
	groupPath: string;
	since: string;
	limit?: number;
}): TaggedOrbitQuery {
	const groupPath = requireSelector(params.groupPath, "groupPath");
	const since = requireSelector(params.since, "since");
	return {
		queryTag: ORBIT_QUERY_TAGS.pipelineFailures,
		dsl: {
			query_type: "aggregation",
			nodes: [
				{
					id: "pl",
					entity: "Pipeline",
					filters: {
						status: { op: "eq", value: "failed" },
						source: PIPELINE_SOURCE_FILTER,
						created_at: { op: "gte", value: since },
					},
				},
				{
					id: "p",
					entity: "Project",
					columns: ["name", "full_path"],
					filters: { full_path: { op: "starts_with", value: `${groupPath}/` } },
				},
			],
			relationships: [{ type: "IN_PROJECT", from: "pl", to: "p" }],
			group_by: [
				{ kind: "property", node: "p", property: "full_path", alias: "project" },
				{ kind: "property", node: "pl", property: "ref", alias: "ref" },
			],
			aggregations: [{ function: "count", target: "pl", alias: "failures" }],
			aggregation_sort: { column: "failures", direction: "DESC" },
			limit: clampLimit(params.limit, 50),
		},
	};
}

// Critical/high vulnerabilities in a group still detected, ranked by severity.
// Selectivity via the group full_path prefix + severity in-filter. (No MR join
// or time window -- the name reflects severity/state filtering by project.)
export function buildRecentVulnerabilitiesQuery(params: { groupPath: string; limit?: number }): TaggedOrbitQuery {
	const groupPath = requireSelector(params.groupPath, "groupPath");
	return {
		queryTag: ORBIT_QUERY_TAGS.recentVulnerabilities,
		dsl: {
			query_type: "traversal",
			nodes: [
				{
					id: "v",
					entity: "Vulnerability",
					columns: ["title", "severity", "state", "report_type"],
					filters: {
						severity: { op: "in", value: ["critical", "high"] },
						state: { op: "eq", value: "detected" },
					},
				},
				{
					id: "p",
					entity: "Project",
					columns: ["name", "full_path"],
					filters: { full_path: { op: "starts_with", value: `${groupPath}/` } },
				},
			],
			relationships: [{ type: "IN_PROJECT", from: "v", to: "p" }],
			order_by: { node: "v", property: "severity", direction: "DESC" },
			limit: clampLimit(params.limit, 50),
		},
	};
}

// SIO-1076: blast-radius enrichment. The blast-radius traversal (Definition <-
// IMPORTS <- ImportedSymbol) cannot also reach the MergeRequest that changed the
// definition -- Definition -> File -> DiffFile -> Diff -> MR is 4 hops, past the
// 3-hop cap. So resolve MR metadata in a SECOND bounded query anchored on the
// changed definition's source file: MergeRequestDiffFile.old_path == sourceFile
// -> HAS_FILE(rev) MergeRequestDiff -> HAS_DIFF(rev) MergeRequest (merged), which
// is 2 hops and selective. The tool stitches merged_at onto the finding.
export function buildMrForFileQuery(params: { sourceFile: string; limit?: number }): TaggedOrbitQuery {
	const sourceFile = requireSelector(params.sourceFile, "sourceFile");
	return {
		// Reuses the blastRadius tag so the extractor merges MR metadata into the
		// same blast-radius findings (enrichment, not a distinct finding type).
		queryTag: ORBIT_QUERY_TAGS.blastRadius,
		dsl: {
			query_type: "traversal",
			nodes: [
				{
					id: "f",
					entity: "MergeRequestDiffFile",
					columns: ["old_path", "new_path"],
					// old_path is stable across renames (dsl correctness rules).
					filters: { old_path: { op: "eq", value: sourceFile } },
				},
				{ id: "d", entity: "MergeRequestDiff", columns: ["id"] },
				{
					id: "mr",
					entity: "MergeRequest",
					columns: ["id", "iid", "title", "state", "merged_at"],
					filters: { state: { op: "eq", value: "merged" } },
				},
			],
			relationships: [
				{ type: "HAS_FILE", from: "d", to: "f" },
				{ type: "HAS_DIFF", from: "mr", to: "d" },
			],
			order_by: { node: "mr", property: "merged_at", direction: "DESC" },
			limit: clampLimit(params.limit, 10),
		},
	};
}
