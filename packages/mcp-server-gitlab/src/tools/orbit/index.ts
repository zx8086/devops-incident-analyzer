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
	buildPipelineFailuresQuery,
	buildRecentDeploysQuery,
	buildVulnsRecentMrQuery,
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
	// Hard per-run cap on paid /orbit/query calls (credit guard). 0 disables the guard.
	maxQueriesPerRun: number;
	defaultGroupPath: string;
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], isError };
}

// Wrap a tagged DSL result plus the raw Orbit rows so the Layer-B extractor can
// branch on queryTag and parse result.rows deterministically.
function taggedPayload(queryTag: OrbitQueryTag, raw: unknown) {
	return JSON.stringify({ queryTag, ...(raw as Record<string, unknown>) }, null, 2);
}

export function registerOrbitTools(server: McpServer, ctx: OrbitToolContext): number {
	let queriesThisProcess = 0;

	// Shared executor for the composed (billed) wrappers. Enforces availability,
	// the per-run credit cap, and soft-fails on any Orbit error.
	async function runQuery(toolName: string, tagged: TaggedOrbitQuery) {
		if (!ctx.client) return textResult(UNAVAILABLE_GUIDANCE, true);

		if (!ctx.available) {
			// One free /status re-check if boot saw "indexing".
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
			if (!ctx.available) return textResult(UNAVAILABLE_GUIDANCE, true);
		}

		if (ctx.maxQueriesPerRun > 0 && queriesThisProcess >= ctx.maxQueriesPerRun) {
			return textResult(
				`Orbit query budget (${ctx.maxQueriesPerRun}) reached for this run; skipping ${toolName}. ` +
					"Use the results already gathered or the per-project REST tools.",
				true,
			);
		}

		try {
			queriesThisProcess += 1;
			const raw = await ctx.client.query(tagged.dsl, "raw");
			return textResult(taggedPayload(tagged.queryTag, raw));
		} catch (error) {
			const detail = error instanceof OrbitUnavailableError ? error.message : String(error);
			log.warn({ toolName, error: detail }, "Orbit query failed; soft-failing to guidance");
			return textResult(`${UNAVAILABLE_GUIDANCE}\n\n(Orbit error: ${detail})`, true);
		}
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
				return runQuery(
					"gitlab_blast_radius",
					buildBlastRadiusQuery({ symbol: p.symbol, groupPath: p.group_path ?? ctx.defaultGroupPath, limit: p.limit }),
				);
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
					buildVulnsRecentMrQuery({ groupPath: p.group_path ?? ctx.defaultGroupPath, limit: p.limit }),
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
				if (!ctx.client) return textResult(UNAVAILABLE_GUIDANCE, true);
				if (!ctx.available) return textResult(UNAVAILABLE_GUIDANCE, true);
				if (ctx.maxQueriesPerRun > 0 && queriesThisProcess >= ctx.maxQueriesPerRun) {
					return textResult(`Orbit query budget (${ctx.maxQueriesPerRun}) reached for this run.`, true);
				}
				try {
					queriesThisProcess += 1;
					const raw = await ctx.client.query(p.query as OrbitQuery, "raw");
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
