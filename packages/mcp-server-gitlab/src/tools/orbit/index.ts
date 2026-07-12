// src/tools/orbit/index.ts

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
import {
	buildBlastRadiusQuery,
	buildCrossProjectCallersQuery,
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

export interface OrbitToolContext {
	client?: OrbitRestClient;
	available: boolean;
	// Optional re-check when a boot status said "indexing"; the handler calls
	// getStatus() once before giving up (single retry, credit-free).
	indexing?: boolean;
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
	return Array.from(files);
}

// First MR node from a buildMrForFileQuery result (rows ordered merged_at DESC).
function firstMrRow(raw: unknown): Record<string, unknown> | undefined {
	for (const row of orbitRows(raw)) {
		const mr = nodeProperties(row.mr);
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

	// Resolve availability: soft-fail unless indexed. One free /status re-check if
	// boot saw "indexing". Returns a guidance result to short-circuit, or null when
	// Orbit is usable.
	async function ensureAvailable() {
		if (!ctx.client) return textResult(UNAVAILABLE_GUIDANCE, true);
		if (ctx.available) return null;
		if (ctx.indexing) {
			try {
				const status = await ctx.client.getStatus();
				if (isOrbitIndexed(status)) {
					ctx.available = true;
					ctx.indexing = false;
				}
			} catch {
				// fall through to guidance
			}
		}
		return ctx.available ? null : textResult(UNAVAILABLE_GUIDANCE, true);
	}

	// Shared executor for the composed (billed) wrappers. Enforces availability,
	// the windowed credit cap, and soft-fails on any Orbit error.
	async function runQuery(toolName: string, tagged: TaggedOrbitQuery) {
		const unavailable = await ensureAvailable();
		if (unavailable) return unavailable;
		const client = ctx.client;
		if (!client) return textResult(UNAVAILABLE_GUIDANCE, true);

		if (!tryConsumeBudget()) {
			return textResult(
				`Orbit query budget (${ctx.maxQueriesPerRun}/${QUERY_WINDOW_MS / 1000}s) reached; skipping ${toolName}. ` +
					"Use the results already gathered or the per-project REST tools.",
				true,
			);
		}

		try {
			const raw = await client.query(tagged.dsl, "raw");
			return textResult(taggedPayload(tagged.queryTag, raw));
		} catch (error) {
			const detail = error instanceof OrbitUnavailableError ? error.message : String(error);
			log.warn({ toolName, error: detail }, "Orbit query failed; soft-failing to guidance");
			return textResult(`${UNAVAILABLE_GUIDANCE}\n\n(Orbit error: ${detail})`, true);
		}
	}

	// gitlab_blast_radius runs the import-traversal, then a SECOND bounded query per
	// distinct changed-definition source file to resolve the merge request that
	// touched it (the 4-hop Definition->MR path exceeds Orbit's 3-hop cap, so the MR
	// metadata is stitched here instead). The payload carries an mrByFile map keyed
	// by source file so the Layer-B extractor can attach mrId/mrMergedAt/mrWebUrl to
	// each blast-radius finding -- without which the flagship deploy-vs-elastic rule
	// (gated on mrMergedAt) can never fire.
	async function runBlastRadius(symbol: string, groupPath: string, limit?: number) {
		const unavailable = await ensureAvailable();
		if (unavailable) return unavailable;
		const client = ctx.client;
		if (!client) return textResult(UNAVAILABLE_GUIDANCE, true);
		if (!tryConsumeBudget()) {
			return textResult(
				`Orbit query budget (${ctx.maxQueriesPerRun}/${QUERY_WINDOW_MS / 1000}s) reached; skipping gitlab_blast_radius.`,
				true,
			);
		}

		let raw: unknown;
		try {
			raw = await client.query(buildBlastRadiusQuery({ symbol, groupPath, limit }).dsl, "raw");
		} catch (error) {
			const detail = error instanceof OrbitUnavailableError ? error.message : String(error);
			log.warn({ tool: "gitlab_blast_radius", error: detail }, "Orbit query failed; soft-failing to guidance");
			return textResult(`${UNAVAILABLE_GUIDANCE}\n\n(Orbit error: ${detail})`, true);
		}

		// Enrich: resolve the recent merged MR per distinct changed-definition file.
		// Bounded to MAX_ENRICH_FILES so one symbol can't fan out unboundedly, and
		// each enrich query still consumes budget (best-effort -- failures are
		// non-fatal and just leave MR metadata absent).
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

		const payload = { queryTag: ORBIT_QUERY_TAGS.blastRadius, ...(raw as Record<string, unknown>), mrByFile };
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
				if (!ctx.client) return textResult(UNAVAILABLE_GUIDANCE, true);
				try {
					const schema = await ctx.client.getSchema();
					return textResult(JSON.stringify(schema, null, 2));
				} catch (error) {
					const detail = error instanceof OrbitUnavailableError ? error.message : String(error);
					return textResult(`${UNAVAILABLE_GUIDANCE}\n\n(Orbit error: ${detail})`, true);
				}
			}),
	);

	// -- gitlab_blast_radius (BILLED) --
	const BlastRadiusParams = z.object({
		symbol: z.string().describe("Function/class/module name or symbol to trace (from a stack trace or a changed file)"),
		group_path: z.string().optional().describe("Top-level group path to scope to (default: pvhcorp)"),
		limit: z.number().int().optional().describe("Max import sites to return (default 200, max 1000)"),
	});
	server.tool(
		"gitlab_blast_radius",
		"Cross-project blast radius: given a symbol/definition, return the downstream files and projects across the " +
			"whole group that IMPORT it. Group-scoped (no per-project resolution needed). Consumes GitLab Credits.",
		BlastRadiusParams.shape,
		async (args) =>
			traceToolCall("gitlab_blast_radius", async () => {
				const p = BlastRadiusParams.parse(args);
				return runBlastRadius(p.symbol, p.group_path ?? ctx.defaultGroupPath, p.limit);
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
		limit: z.number().int().optional().describe("Max MRs to return (default 50, max 1000)"),
	});
	server.tool(
		"gitlab_recent_deploys",
		"List recent deploy merge requests merged across the whole group since a timestamp, ranked newest-first. " +
			"Group-wide (impossible with per-project REST). Consumes GitLab Credits.",
		DeploysParams.shape,
		async (args) =>
			traceToolCall("gitlab_recent_deploys", async () => {
				const p = DeploysParams.parse(args);
				return runQuery(
					"gitlab_recent_deploys",
					buildRecentDeploysQuery({ groupPath: p.group_path ?? ctx.defaultGroupPath, since: p.since, limit: p.limit }),
				);
			}),
	);

	// -- gitlab_pipeline_failures (BILLED, bounded) --
	const FailuresParams = z.object({
		since: z.string().describe("ISO 8601 timestamp; count failures created at or after this time"),
		group_path: z.string().optional().describe("Top-level group path (default: pvhcorp)"),
		limit: z.number().int().optional().describe("Max ranked rows to return (default 50, max 1000)"),
	});
	server.tool(
		"gitlab_pipeline_failures",
		"Rank pipeline failures (source=merge_request_event) across all projects in the group within a window. " +
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
	const RawParams = z.object({
		query: z
			.record(z.string(), z.unknown())
			.describe(
				"A raw Orbit query DSL object (query_type + node/nodes + relationships/aggregations). " +
					"MUST include a selective node (filters/node_ids). Call gitlab_graph_schema first.",
			),
	});
	server.tool(
		"gitlab_orbit_query_graph",
		"Escape hatch: run an arbitrary GitLab Orbit query DSL object for cross-project questions the purpose-built " +
			"tools do not cover. Every query MUST be selective (a filter or node_ids). Consumes GitLab Credits.",
		RawParams.shape,
		async (args) =>
			traceToolCall("gitlab_orbit_query_graph", async () => {
				const p = RawParams.parse(args);
				const query = p.query as OrbitQuery;
				const unavailable = await ensureAvailable();
				if (unavailable) return unavailable;
				const client = ctx.client;
				if (!client) return textResult(UNAVAILABLE_GUIDANCE, true);
				// Selectivity guard: Orbit rejects (but still bills for) an unselective
				// query. The purpose-built tools enforce this via requireSelector; the
				// raw path must validate the LLM's query before the billed call.
				if (!hasSelectiveAnchor(query)) {
					return textResult(
						"Orbit query rejected: every query must include a selective node (a `filters` object, " +
							"`node_ids`, or `id_range`). Call gitlab_graph_schema to ground the query, then retry.",
						true,
					);
				}
				if (!tryConsumeBudget()) {
					return textResult(`Orbit query budget (${ctx.maxQueriesPerRun}/${QUERY_WINDOW_MS / 1000}s) reached.`, true);
				}
				try {
					const raw = await client.query(query, "raw");
					return textResult(JSON.stringify(raw, null, 2));
				} catch (error) {
					const detail = error instanceof OrbitUnavailableError ? error.message : String(error);
					return textResult(`${UNAVAILABLE_GUIDANCE}\n\n(Orbit error: ${detail})`, true);
				}
			}),
	);

	// gitlab_graph_schema + 5 billed wrappers + raw escape hatch = 7 tools.
	return 7;
}
