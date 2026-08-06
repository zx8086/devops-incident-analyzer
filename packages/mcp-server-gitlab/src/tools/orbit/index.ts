// src/tools/orbit/index.ts

import { mapHttpStatusToKind, type ToolErrorKind } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	isOrbitIndexed,
	type OrbitQuery,
	type OrbitRestClient,
	OrbitUnavailableError,
} from "../../gitlab-client/orbit.js";
import { createContextLogger } from "../../utils/logger.js";
import { traceToolCall } from "../../utils/tracing.js";
import { envelopeText } from "../error-envelope.js";
import {
	buildBlastRadiusQuery,
	buildCrossProjectCallersQuery,
	buildDefinitionNameMatchQuery,
	buildMrForFileQuery,
	buildPipelineFailuresQuery,
	buildRecentDeploysQuery,
	buildRecentVulnerabilitiesQuery,
	hasSelectiveAnchor,
	ORBIT_QUERY_TAGS,
	type OrbitQueryTag,
	type TaggedOrbitQuery,
} from "./dsl.js";

const log = createContextLogger("orbit-tools");

// Steered fallback when Orbit is off/unindexed -- mirrors the semantic-search
// "embeddings not ready" guidance so the LLM drops to the REST/semantic path.
const UNAVAILABLE_GUIDANCE =
	"The GitLab Orbit knowledge graph is not available (disabled, still indexing, or the feature is off for this group). " +
	"Fall back to gitlab_semantic_code_search for symbol resolution and gitlab_get_repository_tree / gitlab_list_commits " +
	"for per-project investigation. Do NOT fabricate cross-project import edges.";

// SIO-1294: a compile error means Orbit is UP and rejected this query's shape --
// steering the LLM to the unavailability fallback here would abandon Orbit over a
// fixable DSL mistake. Steer fix-and-retry instead.
const BAD_QUERY_GUIDANCE =
	"Orbit rejected this query shape (compile error) -- Orbit itself is up, so do NOT fall back to other tools. " +
	"Fix the query DSL using the error pointer below and retry; do not blind-retry the same shape. " +
	"Ground the shape with gitlab_graph_schema (free) if unsure.";

export interface OrbitToolContext {
	client?: OrbitRestClient;
	// Boot-probe availability. NOT frozen: while false, every handler re-checks via a
	// credit-free getStatus() and flips this on recovery (SIO-1295) -- a server booted
	// during an Orbit migration/outage picks the graph back up without a restart.
	available: boolean;
	// Ceiling on paid /orbit/query calls per rolling time window (credit guard).
	// 0 disables the guard. NOTE: registerOrbitTools is recorded ONCE by the
	// SIO-1044 cached factory and replayed on every fresh per-request server, so a
	// plain lifetime counter would become a process-wide cap that permanently
	// locks out Orbit after the first burst. Instead this is a rolling window
	// (see QUERY_WINDOW_MS) so a long-lived server always recovers budget.
	maxQueriesPerRun: number;
	defaultGroupPath: string;
}

// Rolling window for the credit guard. maxQueriesPerRun paid queries are allowed
// per window; the window resets on the first query after it elapses.
const QUERY_WINDOW_MS = 60_000;

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], isError };
}

// SIO-1179: Orbit-off/unindexed is a routine environment state, not a malfunction --
// kind "no-index" (category no-data, non-degrading) so it never trips the
// tool-error-rate confidence cap. Prose stays first for the LLM's fallback steering.
function unavailableResult() {
	return textResult(
		envelopeText(UNAVAILABLE_GUIDANCE, { kind: "no-index", message: "GitLab Orbit knowledge graph unavailable" }),
		true,
	);
}

// SIO-1179: classify an Orbit failure structurally. compile_error = a query the
// server rejected (fix the DSL, do not blind-retry); an HTTP status maps through
// the shared table; anything else from OrbitUnavailableError's wrapping is a
// timeout/network-shaped transport failure.
function orbitErrorResult(error: unknown) {
	const isOrbitErr = error instanceof OrbitUnavailableError;
	const detail = isOrbitErr ? error.message : String(error);
	const status = isOrbitErr ? error.status : undefined;
	let kind: ToolErrorKind;
	if (/compile_error/i.test(detail)) kind = "bad-query";
	else if (status !== undefined) kind = mapHttpStatusToKind(status);
	else if (/timed?\s*out|ETIMEDOUT|abort/i.test(detail)) kind = "timeout";
	else kind = "network";
	const guidance = kind === "bad-query" ? BAD_QUERY_GUIDANCE : UNAVAILABLE_GUIDANCE;
	const prose = `${guidance}\n\n(Orbit error: ${detail})`;
	return textResult(envelopeText(prose, { kind, message: detail, statusCode: status }), true);
}

// Wrap a tagged DSL result plus the raw Orbit rows so the Layer-B extractor can
// branch on queryTag and parse result.rows deterministically.
function taggedPayload(queryTag: OrbitQueryTag, raw: unknown) {
	return JSON.stringify({ queryTag, ...(raw as Record<string, unknown>) }, null, 2);
}

// Cap on per-symbol MR-enrichment queries so one blast-radius call can't fan out
// unboundedly across changed files (each enrich query still consumes budget).
const MAX_ENRICH_FILES = 3;

function orbitRows(raw: unknown): Array<Record<string, unknown>> {
	const top = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
	const result = top?.result && typeof top.result === "object" ? (top.result as Record<string, unknown>) : undefined;
	const rows = result?.rows ?? top?.rows;
	return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : [];
}

// SIO-1318: Orbit v0.91 moved traversal results from alias-keyed result.rows to
// flat typed result.nodes (+ result.edges); result.rows now only appears on
// aggregation responses. Emptiness checks and node lookups must read both shapes.
function orbitNodes(raw: unknown): Array<Record<string, unknown>> {
	const top = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
	const result = top?.result && typeof top.result === "object" ? (top.result as Record<string, unknown>) : undefined;
	const nodes = result?.nodes ?? top?.nodes;
	return Array.isArray(nodes) ? nodes.filter((n): n is Record<string, unknown> => !!n && typeof n === "object") : [];
}

function orbitRowCount(raw: unknown): number {
	const rows = orbitRows(raw);
	return rows.length > 0 ? rows.length : orbitNodes(raw).length;
}

function nodeProperties(v: unknown): Record<string, unknown> {
	const rec = v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
	const props =
		rec?.properties && typeof rec.properties === "object" ? (rec.properties as Record<string, unknown>) : undefined;
	return props ?? rec ?? {};
}

// Distinct changed-definition source files from a blast-radius result (def.file_path).
function distinctDefFiles(raw: unknown): string[] {
	const files = new Set<string>();
	for (const row of orbitRows(raw)) {
		const fp = nodeProperties(row.def).file_path;
		if (typeof fp === "string" && fp) files.add(fp);
	}
	for (const node of orbitNodes(raw)) {
		if (node.type !== "Definition") continue;
		const fp = nodeProperties(node).file_path;
		if (typeof fp === "string" && fp) files.add(fp);
	}
	return Array.from(files);
}

// First MR node from a buildMrForFileQuery result (rows ordered merged_at DESC).
function firstMrRow(raw: unknown): Record<string, unknown> | undefined {
	for (const row of orbitRows(raw)) {
		const mr = nodeProperties(row.mr);
		if (Object.keys(mr).length > 0) return mr;
	}
	for (const node of orbitNodes(raw)) {
		if (node.type !== "MergeRequest") continue;
		const mr = nodeProperties(node);
		if (Object.keys(mr).length > 0) return mr;
	}
	return undefined;
}

export function registerOrbitTools(server: McpServer, ctx: OrbitToolContext): number {
	// Rolling-window counter. Reset when the window elapses so a long-lived server
	// (this closure is replayed across every request) recovers budget instead of
	// locking out Orbit permanently after the first burst.
	let windowStart = Date.now();
	let queriesThisWindow = 0;

	// Returns false and does not increment when the paid-query budget is exhausted
	// for the current window; otherwise records the query and returns true.
	function tryConsumeBudget(): boolean {
		if (ctx.maxQueriesPerRun <= 0) return true; // guard disabled
		const now = Date.now();
		if (now - windowStart >= QUERY_WINDOW_MS) {
			windowStart = now;
			queriesThisWindow = 0;
		}
		if (queriesThisWindow >= ctx.maxQueriesPerRun) return false;
		queriesThisWindow += 1;
		return true;
	}

	// Resolve availability: soft-fail unless indexed. SIO-1295: while boot-unavailable
	// (ANY state -- indexing, migrating, failed probe), each handler call makes one free
	// /status re-check so a recovered Orbit is picked up without a process restart.
	// Returns a guidance result to short-circuit, or null when Orbit is usable.
	async function ensureAvailable() {
		if (!ctx.client) return unavailableResult();
		if (ctx.available) return null;
		try {
			const status = await ctx.client.getStatus();
			if (isOrbitIndexed(status)) ctx.available = true;
		} catch {
			// fall through to guidance
		}
		return ctx.available ? null : unavailableResult();
	}

	// Shared executor for the composed (billed) wrappers. Enforces availability,
	// the windowed credit cap, and soft-fails on any Orbit error.
	async function runQuery(toolName: string, tagged: TaggedOrbitQuery) {
		const unavailable = await ensureAvailable();
		if (unavailable) return unavailable;
		const client = ctx.client;
		if (!client) return unavailableResult();

		if (!tryConsumeBudget()) {
			const prose =
				`Orbit query budget (${ctx.maxQueriesPerRun}/${QUERY_WINDOW_MS / 1000}s) reached; skipping ${toolName}. ` +
				"Use the results already gathered or the per-project REST tools.";
			return textResult(envelopeText(prose, { kind: "throttled", message: "Orbit query budget reached" }), true);
		}

		try {
			const raw = await client.query(tagged.dsl, "raw");
			return textResult(taggedPayload(tagged.queryTag, raw));
		} catch (error) {
			const detail = error instanceof OrbitUnavailableError ? error.message : String(error);
			log.warn({ toolName, error: detail }, "Orbit query failed; soft-failing to guidance");
			return orbitErrorResult(error);
		}
	}

	// gitlab_blast_radius runs the import-traversal, then a SECOND bounded query per
	// distinct changed-definition source file to resolve the merge request that
	// touched it (the 4-hop Definition->MR path exceeds Orbit's 3-hop cap, so the MR
	// metadata is stitched here instead). The payload carries an mrByFile map keyed
	// by source file so the Layer-B extractor can attach mrId/mrMergedAt/mrWebUrl to
	// each blast-radius finding -- without which the flagship deploy-vs-elastic rule
	// (gated on mrMergedAt) can never fire.
	async function runBlastRadius(symbol: string, limit?: number) {
		const unavailable = await ensureAvailable();
		if (unavailable) return unavailable;
		const client = ctx.client;
		if (!client) return unavailableResult();
		if (!tryConsumeBudget()) {
			const prose = `Orbit query budget (${ctx.maxQueriesPerRun}/${QUERY_WINDOW_MS / 1000}s) reached; skipping gitlab_blast_radius.`;
			return textResult(envelopeText(prose, { kind: "throttled", message: "Orbit query budget reached" }), true);
		}

		let raw: unknown;
		try {
			raw = await client.query(buildBlastRadiusQuery({ symbol, limit }).dsl, "raw");
		} catch (error) {
			const detail = error instanceof OrbitUnavailableError ? error.message : String(error);
			log.warn({ tool: "gitlab_blast_radius", error: detail }, "Orbit query failed; soft-failing to guidance");
			return orbitErrorResult(error);
		}

		// SIO-1303: the IMPORTS join is structurally blind to Java same-package and
		// cross-service REST coupling (neither produces an import statement), so a
		// 0-row result does not mean "no blast radius" -- it means the join can't see
		// it. Fall back to a Definition name-sweep, one extra billed call, fail-open
		// on budget exhaustion (skip the fallback, return the empty primary result)
		// and non-fatal on error (fall through the same way). radiusMode tags the
		// payload so the extractor and the LLM both know these rows are name
		// co-occurrences across repos, not confirmed import edges.
		let radiusMode: "definition-name-match" | undefined;
		if (orbitRowCount(raw) === 0 && tryConsumeBudget()) {
			try {
				const fallbackRaw = await client.query(buildDefinitionNameMatchQuery({ symbol, limit }).dsl, "raw");
				if (orbitRowCount(fallbackRaw) > 0) {
					raw = fallbackRaw;
					radiusMode = "definition-name-match";
				}
			} catch {
				// leave raw as the empty primary result; blast radius is still reported
			}
		}

		// Enrich: resolve the recent merged MR per distinct changed-definition file.
		// Bounded to MAX_ENRICH_FILES so one symbol can't fan out unboundedly, and
		// each enrich query still consumes budget (best-effort -- failures are
		// non-fatal and just leave MR metadata absent). Works unmodified for
		// fallback rows too: both query shapes carry def.file_path.
		const files = distinctDefFiles(raw).slice(0, MAX_ENRICH_FILES);
		const mrByFile: Record<string, unknown> = {};
		for (const file of files) {
			if (!tryConsumeBudget()) break;
			try {
				const mrRaw = await client.query(buildMrForFileQuery({ sourceFile: file }).dsl, "raw");
				const mr = firstMrRow(mrRaw);
				if (mr) mrByFile[file] = mr;
			} catch {
				// leave this file's MR metadata absent; blast radius is still useful
			}
		}

		const payload = {
			queryTag: ORBIT_QUERY_TAGS.blastRadius,
			...(raw as Record<string, unknown>),
			mrByFile,
			...(radiusMode ? { radiusMode } : {}),
		};
		return textResult(JSON.stringify(payload, null, 2));
	}

	// -- gitlab_graph_schema (FREE) --
	server.tool(
		"gitlab_graph_schema",
		"Return the GitLab Orbit knowledge-graph schema (node and relationship types). Free (no GitLab Credits). " +
			"Call this first to ground cross-project graph queries.",
		{},
		async () =>
			traceToolCall("gitlab_graph_schema", async () => {
				// Free, but still gated: the SIO-1295 recovery re-check must fire even when
				// this is the first handler invoked, and an Orbit-off schema call should
				// return the non-degrading no-index envelope, not an HTTP-mapped error.
				const unavailable = await ensureAvailable();
				if (unavailable) return unavailable;
				const client = ctx.client;
				if (!client) return unavailableResult();
				try {
					const schema = await client.getSchema();
					return textResult(JSON.stringify(schema, null, 2));
				} catch (error) {
					return orbitErrorResult(error);
				}
			}),
	);

	// -- gitlab_blast_radius (BILLED) --
	// SIO-1179: no group_path param -- the old one only injected a dead
	// ImportedSymbol.file_path filter (repo-relative paths never contain the group
	// path), which made every call return 0 rows. The index is group-scoped already.
	const BlastRadiusParams = z.object({
		symbol: z.string().describe("Function/class/module name or symbol to trace (from a stack trace or a changed file)"),
		limit: z.number().int().optional().describe("Max import sites to return (default 200, max 1000)"),
	});
	server.tool(
		"gitlab_blast_radius",
		"Cross-project blast radius: given a symbol/definition, return the downstream files and projects across the " +
			"whole group that IMPORT it. Group-scoped (no per-project resolution needed). If no import edges are found " +
			"(common for Java/C# same-package or REST coupling, which produce no import statement), falls back to a " +
			'definition name-match sweep -- the payload carries radiusMode: "definition-name-match" and those rows are ' +
			"name co-occurrences across repos (REST clients, contracts, tests), NOT confirmed importers; treat them as " +
			"lower-confidence. Consumes GitLab Credits.",
		BlastRadiusParams.shape,
		async (args) =>
			traceToolCall("gitlab_blast_radius", async () => {
				const p = BlastRadiusParams.parse(args);
				return runBlastRadius(p.symbol, p.limit);
			}),
	);

	// -- gitlab_cross_project_callers (BILLED) --
	const CallersParams = z.object({
		fqn: z.string().describe("Fully-qualified definition name (e.g. Gitlab::Auth::authenticate)"),
		limit: z.number().int().optional().describe("Max caller sites to return (default 200, max 1000)"),
	});
	server.tool(
		"gitlab_cross_project_callers",
		"List the callers/importers of a fully-qualified definition across every repo in the group. " +
			"Group-scoped. Consumes GitLab Credits.",
		CallersParams.shape,
		async (args) =>
			traceToolCall("gitlab_cross_project_callers", async () => {
				const p = CallersParams.parse(args);
				return runQuery("gitlab_cross_project_callers", buildCrossProjectCallersQuery({ fqn: p.fqn, limit: p.limit }));
			}),
	);

	// -- gitlab_recent_deploys (BILLED, bounded) --
	const DeploysParams = z.object({
		since: z.string().describe("ISO 8601 timestamp; return MRs merged at or after this time"),
		group_path: z.string().optional().describe("Top-level group path (default: pvhcorp)"),
		project_path: z
			.string()
			.optional()
			.describe(
				"SIO-1298: exact project full_path (e.g. pvhcorp/b2b/oit/order-service). Scopes the query to that one project -- use for the 30-day escalation call when the owning codebase is known",
			),
		limit: z.number().int().optional().describe("Max MRs to return (default 50, max 1000)"),
	});
	server.tool(
		"gitlab_recent_deploys",
		"List recent deploy merge requests merged across the whole group (or one project via project_path) since a timestamp, ranked newest-first. " +
			"Group-wide (impossible with per-project REST). Consumes GitLab Credits.",
		DeploysParams.shape,
		async (args) =>
			traceToolCall("gitlab_recent_deploys", async () => {
				const p = DeploysParams.parse(args);
				return runQuery(
					"gitlab_recent_deploys",
					buildRecentDeploysQuery({
						groupPath: p.group_path ?? ctx.defaultGroupPath,
						since: p.since,
						limit: p.limit,
						projectPath: p.project_path,
					}),
				);
			}),
	);

	// -- gitlab_pipeline_failures (BILLED, bounded) --
	const FailuresParams = z.object({
		since: z.string().describe("ISO 8601 timestamp; count failures created at or after this time"),
		group_path: z.string().optional().describe("Top-level group path (default: pvhcorp)"),
		project_path: z
			.string()
			.optional()
			.describe(
				"SIO-1298: exact project full_path (e.g. pvhcorp/b2b/oit/order-service). Scopes the query to that one project -- use for the 30-day escalation call when the owning codebase is known",
			),
		limit: z.number().int().optional().describe("Max ranked rows to return (default 50, max 1000)"),
	});
	server.tool(
		"gitlab_pipeline_failures",
		"Rank pipeline failures (source=merge_request_event) across all projects in the group (or one project via project_path) within a window. " +
			"Group-wide aggregation. Consumes GitLab Credits.",
		FailuresParams.shape,
		async (args) =>
			traceToolCall("gitlab_pipeline_failures", async () => {
				const p = FailuresParams.parse(args);
				return runQuery(
					"gitlab_pipeline_failures",
					buildPipelineFailuresQuery({
						groupPath: p.group_path ?? ctx.defaultGroupPath,
						since: p.since,
						limit: p.limit,
						projectPath: p.project_path,
					}),
				);
			}),
	);

	// -- gitlab_recent_vulnerabilities (BILLED, bounded) --
	const VulnParams = z.object({
		group_path: z.string().optional().describe("Top-level group path (default: pvhcorp)"),
		limit: z.number().int().optional().describe("Max vulnerabilities to return (default 50, max 1000)"),
	});
	server.tool(
		"gitlab_recent_vulnerabilities",
		"List critical/high vulnerabilities still detected across the group, ranked by severity. " +
			"Group-wide. Consumes GitLab Credits.",
		VulnParams.shape,
		async (args) =>
			traceToolCall("gitlab_recent_vulnerabilities", async () => {
				const p = VulnParams.parse(args);
				return runQuery(
					"gitlab_recent_vulnerabilities",
					buildRecentVulnerabilitiesQuery({ groupPath: p.group_path ?? ctx.defaultGroupPath, limit: p.limit }),
				);
			}),
	);

	// -- gitlab_orbit_query_graph (BILLED, raw escape hatch) --
	//
	// SIO-1408: `query` used to be a bare `z.record(z.string(), z.unknown())`, which serialises to
	// `additionalProperties: {}` -- ANY object passes JSON-Schema, so the model got no structural
	// signal whatsoever and only learned it was wrong from Orbit's own validator, after the call.
	// Measured live: 10 attempts in one eval example, 10 rejections, 0 successes. The model was
	// not guessing badly; it was guessing blind.
	//
	// The DSL is now typed, so a malformed query is rejected LOCALLY with a -32602 naming the
	// offending field, and the shape is discoverable from tools/list without a second call.
	// Deliberately permissive at the leaves (`filters` and `aggregations` values stay unknown):
	// the operator grammar is broad and Orbit is the authority on it, so over-tightening here
	// would reject valid queries. The win is the SKELETON being explicit.
	const OrbitNodeSelector = z.object({
		id: z.string().describe("Local alias for this node, referenced by relationships/path/neighbors."),
		entity: z.string().describe("Ontology node type: Project, User, MergeRequest, File, Definition, Pipeline, ..."),
		columns: z
			.union([z.literal("*"), z.array(z.string())])
			.optional()
			.describe('Properties to return. "*" for all non-restricted, or an array of names. Max 50.'),
		filters: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				'Property filters. Simple equality {"state":"merged"} or an operator object ' +
					'{"path":{"ends_with":"app/models/project.rb"}}. Operators: eq, gt, gte, lt, lte, in, contains, ' +
					"starts_with, ends_with, is_null, is_not_null, token_match, all_tokens, any_tokens. Max 10 per node.",
			),
		node_ids: z
			.array(z.union([z.number(), z.string()]))
			.optional()
			.describe(
				"Exact INTERNAL graph ids (not project-scoped iids). Max 500. A wrong id class returns 0 rows " +
					"WITHOUT erroring, so prefer `filters` unless you resolved the id from a prior query.",
			),
		id_range: z.object({ start: z.number(), end: z.number() }).optional().describe("Inclusive graph-id range."),
		id_property: z.string().optional().describe("Property used by node_ids/id_range. Default `id`."),
	});

	const OrbitRelationship = z.object({
		type: z.union([z.string(), z.array(z.string())]).describe('Relationship type(s), e.g. "IN_PROJECT", "AUTHORED".'),
		from: z.string().describe("Alias of the start node selector."),
		to: z.string().describe("Alias of the end node selector."),
		direction: z.enum(["outgoing", "incoming", "both"]).optional().describe("Default outgoing."),
		hops: z.array(z.number()).optional().describe("Inclusive [min,max] hop range. Default [1,1]. Max 3."),
		filters: z.record(z.string(), z.unknown()).optional().describe("Relationship property filters. Max 5."),
	});

	const OrbitQuerySchema = z.object({
		query_type: z
			.enum(["traversal", "aggregation", "path_finding", "neighbors"])
			.describe(
				"traversal: fetch nodes or follow relationships -- SINGLE-NODE TRAVERSAL IS THE SEARCH SHAPE " +
					"(there is no `search` query_type). aggregation: count/sum/avg/group. path_finding: bounded path " +
					"between two selectors. neighbors: what connects to one bounded node.",
			),
		nodes: z
			.array(OrbitNodeSelector)
			.min(1)
			.max(5)
			.describe("Node selectors, always required. Single-node queries use a 1-element array."),
		relationships: z.array(OrbitRelationship).max(5).optional(),
		aggregations: z
			.array(z.record(z.string(), z.unknown()))
			.max(10)
			.optional()
			.describe('Required for aggregation. One function key each: {"count":"mr","as":"merged_mrs"}.'),
		group_by: z.array(z.unknown()).max(4).optional().describe('Group keys: "node" or "node.property".'),
		path: z.record(z.string(), z.unknown()).optional().describe("Required for path_finding: {type,from,to,max_depth}."),
		neighbors: z.record(z.string(), z.unknown()).optional().describe("Required for neighbors: {direction,rel_types}."),
		limit: z.number().int().max(1000).optional().describe("Rows to return. Default 30, max 1000."),
		cursor: z.record(z.string(), z.unknown()).optional().describe("Keyset pagination: {page_size, after}."),
		order_by: z.string().optional().describe('Sort by node property: "node.prop" asc, "-node.prop" desc.'),
		aggregation_sort: z.string().optional().describe("Sort aggregation rows by output column name."),
		options: z.record(z.string(), z.unknown()).optional(),
	});

	const RawParams = z.object({
		query: OrbitQuerySchema.describe(
			"Orbit query DSL object. EXAMPLE (single-node traversal = search): " +
				'{"query_type":"traversal","nodes":[{"id":"file","entity":"File",' +
				'"filters":{"path":{"ends_with":"app/models/project.rb"}},"columns":["path","language"]}],"limit":5}. ' +
				"MUST include a selective node (filters, node_ids, or a narrow id_range) -- an unselective query is " +
				"rejected AND billed. Call gitlab_graph_schema for the entity/relationship ontology.",
		),
	});
	server.tool(
		"gitlab_orbit_query_graph",
		"Escape hatch: run an arbitrary GitLab Orbit query DSL object for cross-project questions the purpose-built " +
			"tools do not cover. Every query MUST be selective (a filter or node_ids). Consumes GitLab Credits. " +
			'Search = single-node traversal, e.g. {"query_type":"traversal","nodes":[{"id":"f","entity":"File",' +
			'"filters":{"path":{"ends_with":"README.md"}},"columns":["path"]}],"limit":5}.',
		RawParams.shape,
		async (args) =>
			traceToolCall("gitlab_orbit_query_graph", async () => {
				const p = RawParams.parse(args);
				const query = p.query as OrbitQuery;
				const unavailable = await ensureAvailable();
				if (unavailable) return unavailable;
				const client = ctx.client;
				if (!client) return unavailableResult();
				// Selectivity guard: Orbit rejects (but still bills for) an unselective
				// query. The purpose-built tools enforce this via requireSelector; the
				// raw path must validate the LLM's query before the billed call.
				if (!hasSelectiveAnchor(query)) {
					// SIO-1408: the rejection now SHOWS a valid query rather than only naming the rule.
					// A model that gets the shape wrong ten times in a row (measured) cannot recover from
					// a description of the constraint -- it needs the payload.
					const prose =
						"Orbit query rejected: every query must include a selective node (a `filters` object, " +
						"`node_ids`, or `id_range`). Example of a valid selective query:\n" +
						'{"query_type":"traversal","nodes":[{"id":"file","entity":"File",' +
						'"filters":{"path":{"ends_with":"README.md"}},"columns":["path","language"]}],"limit":5}\n' +
						"Note: single-node traversal IS the search shape (there is no `search` query_type), and " +
						"filters take operator objects, not bare values. Call gitlab_graph_schema for the ontology.";
					return textResult(
						envelopeText(prose, { kind: "bad-query", message: "Unselective Orbit query rejected" }),
						true,
					);
				}
				if (!tryConsumeBudget()) {
					const prose = `Orbit query budget (${ctx.maxQueriesPerRun}/${QUERY_WINDOW_MS / 1000}s) reached.`;
					return textResult(envelopeText(prose, { kind: "throttled", message: "Orbit query budget reached" }), true);
				}
				try {
					const raw = await client.query(query, "raw");
					return textResult(JSON.stringify(raw, null, 2));
				} catch (error) {
					return orbitErrorResult(error);
				}
			}),
	);

	// gitlab_graph_schema + 5 billed wrappers + raw escape hatch = 7 tools.
	const registered = [
		"gitlab_graph_schema",
		"gitlab_blast_radius",
		"gitlab_cross_project_callers",
		"gitlab_recent_deploys",
		"gitlab_pipeline_failures",
		"gitlab_recent_vulnerabilities",
		"gitlab_orbit_query_graph",
	];
	log.info({ count: registered.length, tools: registered }, "Orbit tools registered");
	return registered.length;
}
