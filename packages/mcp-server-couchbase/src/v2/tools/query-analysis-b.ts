// src/v2/tools/query-analysis-b.ts
//
// SIO-1443: v2 port of the second alphabetical half (10 of 21) of the query-analysis tools --
// pure SQL++ reads against Couchbase's system catalogs (system:completed_requests,
// system:indexes, system:prepareds, system:nodes, system:vitals), plus the offline/live
// query-optimization advisor. Re-implemented against @modelcontextprotocol/server's registerTool
// config style -- v1's tool files (packages/mcp-server-couchbase/src/tools/queryAnalysis/*.ts)
// import McpServer from @modelcontextprotocol/sdk, a different package, so they are read as
// reference only, not imported. Handler bodies, buildQuery logic, and Zod schemas are ported
// verbatim; only the server/registration plumbing changes. Annotations are hand-written per tool
// below (see tool-classification.ts's READ_ONLY_TOOLS Set -- all 10 tools here are plain reads,
// none are in WRITE_TOOLS/DESTRUCTIVE_TOOLS) since couchbaseToolAnnotations() itself is v1-only
// (imports ToolAnnotations from the v1 SDK's types module).
//
// Shared query-execution helper: SAME decision as Task 4 (query-analysis-a.ts) -- v1's
// queryAnalysisUtils.ts (executeAnalysisQuery) and analysisQueries.ts (the N1QL string constants)
// are BOTH SDK-agnostic (import only `couchbase`, `@devops-agent/shared`, and local lib/utils
// modules, never `@modelcontextprotocol/sdk`), so they are imported directly here rather than
// ported, keeping the underlying SQL++ byte-identical between v1 and v2 by construction.
//
// capella_suggest_query_optimizations additionally needs getIndexAdvisor.ts's buildQuery/
// extractAdvisorSections. getIndexAdvisor.ts's only SDK reference is `import type { McpServer }`
// (type-only, erased at compile time -- core.ts already imports its `adviseQuery` directly for
// the same reason), but Task 4 chose to PORT a local copy of extractAdvisorSections/
// formatAdvisorResult into query-analysis-a.ts rather than import them, for
// capella_get_index_advisor_recommendations's own local helper. Following that precedent here:
// buildQuery (renamed buildAdvisorQuery to avoid a name collision with this file's other
// buildQuery-shaped locals) and extractAdvisorSections are ported verbatim as local helpers
// rather than imported from the v1 tool file.
//
// Hidden-gate check (SIO-1443 lesson from Tasks 2/3): 9 of these 10 tools (everything except
// capella_suggest_query_optimizations) have no config/feature-flag gate -- confirmed by grepping
// each reference file for `config.`/`process.env`/`Bun.env`, all empty. The 10th,
// capella_suggest_query_optimizations, DOES have a hidden dependency: its live-analysis path
// (ported here as runLiveOptimizationAnalysis) reads config.server.readOnlyQueryMode to decide
// whether to run the EXPLAIN leg (skipped for mutating statements in read-only mode, mirroring
// capella_explain_sql_plus_plus_query's own gate in core.ts). That gate is preserved verbatim
// below via the same `config` import core.ts already uses for the identical check.

import type { McpServer, RegisteredTool, ToolAnnotations } from "@modelcontextprotocol/server";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { config } from "../../config";
import { connectionManager } from "../../lib/connectionManager";
import { evaluateQueryPlan, formatPlanFindings } from "../../lib/queryPlan";
import { resolveBucket } from "../../lib/resolveBucket";
import { sqlppParser } from "../../lib/sqlppParser";
import {
	DEFAULT_ANALYSIS_LIMIT,
	mostExpensiveQueries,
	n1qlIndexAdvisor,
	n1qlLowSelectivityQueries,
	n1qlMostFrequentQueries,
	n1qlNonCoveringIndexQueries,
	n1qlPreparedStatements,
	n1qlPrimaryIndexes,
	n1qlSystemIndexes,
	systemNodesQuery,
	systemVitalsQuery,
} from "../../tools/queryAnalysis/analysisQueries";
import { executeAnalysisQuery } from "../../tools/queryAnalysis/queryAnalysisUtils";
import { logger } from "../../utils/logger";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };

export function registerQueryAnalysisToolsBV2(server: McpServer, tools: Map<string, RegisteredTool>): void {
	// capella_get_low_selectivity_queries -- ported verbatim from getLowSelectivityQueries.ts.
	const getLowSelectivityQueries = server.registerTool(
		"capella_get_low_selectivity_queries",
		{
			description:
				"Get queries whose index scans read far more entries than they returned (poor selectivity; the index or predicate filters too little). Empty results can mean request logging thresholds excluded fast queries.",
			inputSchema: z.object({
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ limit }) => {
			logger.info({ limit }, "Getting low selectivity queries");
			const bucket = await connectionManager.getConnection();
			let query = n1qlLowSelectivityQueries;
			// LIMIT is zod-validated as a positive integer before this splice (SIO-667
			// posture: values bind as $named params; LIMIT cannot be parameterized in N1QL).
			if (limit !== undefined && limit > 0) {
				query = `${query.trim().replace(/;$/, "")} LIMIT ${limit};`;
			}
			return executeAnalysisQuery(bucket, query, "Queries With Low Index Selectivity", limit);
		},
	);
	tools.set("capella_get_low_selectivity_queries", getLowSelectivityQueries);

	// capella_get_most_expensive_queries -- ported verbatim from getMostExpensiveQueries.ts.
	const getMostExpensiveQueries = server.registerTool(
		"capella_get_most_expensive_queries",
		{
			description:
				"Get the most expensive queries based on execution time and resource usage (defaults: last 8 weeks, limit 50)",
			inputSchema: z.object({
				limit: z
					.number()
					.int()
					.optional()
					.describe("Optional integer limit for the number of results to return (default 50)"),
				period: z
					.enum(["day", "week", "month"])
					.optional()
					.describe("Optional period to analyze (day, week, month); defaults to the last 8 weeks"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (input) => {
			logger.info(input, "Getting most expensive queries");
			const bucket = await connectionManager.getConnection();
			const { limit, period } = input;
			let query = mostExpensiveQueries;

			// SIO-668: the substitutions are built from a closed switch over a Zod enum, so
			// no user input ever reaches the SQL string. No parameters needed.
			// SIO-1175: the base query carries a default 8-week window; period REWRITES that
			// window (mirrors getCompletedRequests) instead of adding a second predicate,
			// and a LIMIT is always applied so the GROUP BY + ORDER BY stays bounded.
			if (period) {
				let periodUnit: string;
				switch (period) {
					case "day":
						periodUnit = "day";
						break;
					case "week":
						periodUnit = "week";
						break;
					case "month":
						periodUnit = "month";
						break;
				}
				query = query.replace(
					/DATE_ADD_STR\(NOW_STR\(\), -\d+, '\w+'\)/,
					`DATE_ADD_STR(NOW_STR(), -1, '${periodUnit}')`,
				);
			}

			const effectiveLimit = limit && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_ANALYSIS_LIMIT;
			if (/LIMIT \d+/i.test(query)) {
				query = query.replace(/LIMIT \d+/i, `LIMIT ${effectiveLimit}`);
			} else {
				query = query.replace(/;\s*$/, ` LIMIT ${effectiveLimit};`);
			}

			return executeAnalysisQuery(bucket, query, "Most Expensive Queries", limit, {});
		},
	);
	tools.set("capella_get_most_expensive_queries", getMostExpensiveQueries);

	// capella_get_most_frequent_queries -- ported verbatim from getMostFrequentQueries.ts.
	const getMostFrequentQueries = server.registerTool(
		"capella_get_most_frequent_queries",
		{
			description: "Get the most frequently executed queries",
			inputSchema: z.object({
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
				min_count: z.number().optional().describe("Minimum execution count to include"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ limit, min_count }) => {
			logger.info({ limit, min_count }, "Getting most frequent queries");
			const bucket = await connectionManager.getConnection();

			let query = n1qlMostFrequentQueries;

			if (min_count && min_count > 0) {
				query = query.replace(
					"LETTING queries = COUNT(1)",
					`LETTING queries = COUNT(1)
           HAVING queries >= ${min_count}`,
				);
			}

			if (limit && Number.isInteger(limit) && limit > 0) {
				query = query.includes("LIMIT")
					? query.replace(/LIMIT \d+/i, `LIMIT ${limit}`)
					: `${query.replace(";", "")} LIMIT ${limit};`;
			}

			return executeAnalysisQuery(bucket, query, "Most Frequently Executed Queries", limit);
		},
	);
	tools.set("capella_get_most_frequent_queries", getMostFrequentQueries);

	// capella_get_non_covering_index_queries -- ported verbatim from getNonCoveringIndexQueries.ts.
	const getNonCoveringIndexQueries = server.registerTool(
		"capella_get_non_covering_index_queries",
		{
			description:
				"Get queries whose index scans still required a document fetch phase (the index did not cover the query). Empty results can mean request logging thresholds excluded fast queries.",
			inputSchema: z.object({
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ limit }) => {
			logger.info({ limit }, "Getting non-covering index queries");
			const bucket = await connectionManager.getConnection();
			let query = n1qlNonCoveringIndexQueries;
			// LIMIT is zod-validated as a positive integer before this splice (SIO-667
			// posture: values bind as $named params; LIMIT cannot be parameterized in N1QL).
			if (limit !== undefined && limit > 0) {
				query = `${query.trim().replace(/;$/, "")} LIMIT ${limit};`;
			}
			return executeAnalysisQuery(bucket, query, "Queries Not Using a Covering Index", limit);
		},
	);
	tools.set("capella_get_non_covering_index_queries", getNonCoveringIndexQueries);

	// capella_get_prepared_statements -- ported verbatim from getPreparedStatements.ts.
	const getPreparedStatements = server.registerTool(
		"capella_get_prepared_statements",
		{
			description: "Get information about prepared statements in the query engine",
			inputSchema: z.object({
				limit: z.number().optional().describe("Optional limit for the number of results to return"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ limit }) => {
			logger.info({ limit }, "Getting prepared statements");
			const bucket = await connectionManager.getConnection();

			let query = n1qlPreparedStatements;

			if (limit && Number.isInteger(limit) && limit > 0) {
				query = query.includes("LIMIT")
					? query.replace(/LIMIT \d+/i, `LIMIT ${limit}`)
					: `${query.replace(";", "")} LIMIT ${limit};`;
			}

			return executeAnalysisQuery(bucket, query, "Prepared Statements", limit);
		},
	);
	tools.set("capella_get_prepared_statements", getPreparedStatements);

	// capella_get_primary_index_queries -- ported verbatim from getPrimaryIndexQueries.ts.
	const getPrimaryIndexQueries = server.registerTool(
		"capella_get_primary_index_queries",
		{
			description: "Get queries that used primary indexes, which can indicate inefficient querying",
			inputSchema: z.object({
				limit: z.number().optional().describe("Optional limit for the number of results to return"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ limit }) => {
			logger.info({ limit }, "Getting primary index queries");
			const bucket = await connectionManager.getConnection();

			let query = n1qlPrimaryIndexes;

			if (limit && Number.isInteger(limit) && limit > 0) {
				query = query.includes("LIMIT")
					? query.replace(/LIMIT \d+/i, `LIMIT ${limit}`)
					: `${query.replace(";", "")} LIMIT ${limit};`;
			}

			return executeAnalysisQuery(bucket, query, "Queries Using Primary Indexes", limit);
		},
	);
	tools.set("capella_get_primary_index_queries", getPrimaryIndexQueries);

	// capella_get_system_indexes -- ported verbatim from getSystemIndexes.ts.
	const getSystemIndexes = server.registerTool(
		"capella_get_system_indexes",
		{
			description: "Get information about all indexes in the system",
			inputSchema: z.object({
				bucket_name: z.string().optional().describe("Filter by bucket name"),
				index_type: z.string().optional().describe("Filter by index type (e.g., GSI, FTS)"),
				include_system: z.boolean().optional().describe("Whether to include system indexes"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (input) => {
			logger.info(input, "Getting system indexes");
			const bucket = await connectionManager.getConnection();
			const { bucket_name, index_type, include_system } = input;
			const whereClauses: string[] = [];
			const parameters: Record<string, unknown> = {};

			if (bucket_name) {
				whereClauses.push("t.keyspace_id = $bucket_name");
				parameters.bucket_name = bucket_name;
			}
			if (index_type) {
				// `using` is a SQL++ reserved word -- unescaped it fails to parse. The catalog
				// stores lowercase ("gsi") while callers pass "GSI"; compare case-insensitively.
				whereClauses.push("LOWER(t.`using`) = LOWER($index_type)");
				parameters.index_type = index_type;
			}
			if (include_system !== true) {
				whereClauses.push("t.`namespace` != 'system'");
			}

			const whereFragment = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
			const query = n1qlSystemIndexes.replace("/* WHERE_CLAUSES */", whereFragment);

			return executeAnalysisQuery(bucket, query, "System Indexes", undefined, parameters);
		},
	);
	tools.set("capella_get_system_indexes", getSystemIndexes);

	// capella_get_system_nodes -- ported verbatim from getSystemNodes.ts.
	const getSystemNodes = server.registerTool(
		"capella_get_system_nodes",
		{
			description: "Get information about all nodes in the Couchbase cluster",
			inputSchema: z.object({
				service_filter: z.string().optional().describe("Filter by service type (e.g., 'n1ql', 'kv', 'index', 'fts')"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (input) => {
			logger.info(input, "Getting system nodes information");
			const bucket = await connectionManager.getConnection();
			const { service_filter } = input;
			const { query, parameters } = service_filter
				? {
						query: "SELECT * FROM system:nodes WHERE ANY s IN services SATISFIES s = $service_filter END;",
						parameters: { service_filter },
					}
				: { query: systemNodesQuery, parameters: {} };

			return executeAnalysisQuery(bucket, query, "Couchbase Cluster Nodes", undefined, parameters);
		},
	);
	tools.set("capella_get_system_nodes", getSystemNodes);

	// capella_get_system_vitals -- ported verbatim from getSystemVitals.ts.
	const getSystemVitals = server.registerTool(
		"capella_get_system_vitals",
		{
			description: "Get detailed system vitals and performance metrics for the Couchbase cluster",
			inputSchema: z.object({
				node_filter: z.string().optional().describe("Filter by node name (e.g., 'node1.example.com:8091')"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (input) => {
			logger.info(input, "Getting system vitals information");
			const bucket = await connectionManager.getConnection();
			const { node_filter } = input;
			// SIO-667: build the LIKE pattern in JS and bind the whole pattern as a literal.
			// Wildcard semantics for `%`/`_` inside the user value are preserved (matches
			// pre-fix behavior); the change closes the SQL injection vector by preventing
			// the value from escaping the string-literal context.
			const { query, parameters } = node_filter
				? {
						query: "SELECT * FROM system:vitals WHERE node LIKE $node_pattern;",
						parameters: { node_pattern: `%${node_filter}%` },
					}
				: { query: systemVitalsQuery, parameters: {} };

			return executeAnalysisQuery(bucket, query, "Couchbase System Vitals", undefined, parameters);
		},
	);
	tools.set("capella_get_system_vitals", getSystemVitals);

	// capella_suggest_query_optimizations -- ported verbatim from suggestQueryOptimizations.ts.
	const suggestQueryOptimizations = server.registerTool(
		"capella_suggest_query_optimizations",
		{
			description:
				"Analyze a query and suggest optimizations and indexes. Uses the live Index Advisor and EXPLAIN plan when the cluster is reachable; falls back to offline heuristic analysis otherwise.",
			inputSchema: z.object({
				query: z.string().describe("The N1QL query to analyze"),
				bucket_name: z.string().optional().describe("Bucket name (defaults to bucket in query)"),
				scope_name: z.string().optional().describe("Scope name (defaults to scope in query)"),
				collection_name: z.string().optional().describe("Collection name (defaults to collection in query)"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ query, bucket_name, scope_name, collection_name }) => {
			logger.info({ query, bucket_name, scope_name, collection_name }, "Analyzing query for optimizations");
			const bucket = await connectionManager.getConnection();

			try {
				const { extractedBucket, extractedScope, extractedCollection } = extractQueryComponents(query);

				const targetBucket = bucket_name || extractedBucket || bucket.name;
				const targetScope = scope_name || extractedScope || "_default";
				const targetCollection = collection_name || extractedCollection || "_default";

				// SIO-1107: live ADVISOR + EXPLAIN first; regex heuristics only as fallback.
				// Route through the DERIVED bucket (explicit arg > extracted-from-query >
				// default) so a fully-qualified non-default-bucket query analyzes the right
				// bucket instead of silently using the configured handle (CodeRabbit, PR #378).
				const live = await runLiveOptimizationAnalysis(query, targetScope, bucket, targetBucket);
				if (live !== null) {
					return { content: [{ type: "text" as const, text: live }] };
				}

				const analysis = analyzeQuery(query);
				const banner =
					"> Heuristic fallback (cluster unavailable): the live Index Advisor and EXPLAIN could not be reached, so the following is offline pattern analysis. Re-run when the cluster is reachable, or use capella_get_index_advisor_recommendations directly.\n\n";
				return {
					content: [
						{
							type: "text" as const,
							text:
								banner + formatOptimizationSuggestions(query, analysis, targetBucket, targetScope, targetCollection),
						},
					],
				};
			} catch (error) {
				logger.error(`Error analyzing query: ${error instanceof Error ? error.message : String(error)}`);

				return {
					content: [
						{
							type: "text" as const,
							text: `## Error Analyzing Query\n\n${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);
	tools.set("capella_suggest_query_optimizations", suggestQueryOptimizations);
}

// ---- capella_suggest_query_optimizations helpers, ported from getIndexAdvisor.ts (SIO-1443:
// Task 4 precedent -- local copy rather than an import, since capella_get_index_advisor_recommendations
// in query-analysis-a.ts already ported its own local copy of extractAdvisorSections instead of
// importing the v1 tool file) ----

interface AdvisorSections {
	current: string[];
	recommended: string[];
	covering: string[];
}

// The analyzed statement binds as $advise_statement -- injection-closed by construction (SIO-667
// posture; mirrors the official Python server). Renamed from getIndexAdvisor.ts's `buildQuery` to
// avoid colliding with this file's other buildQuery-shaped local logic.
function buildAdvisorQuery(query: string): { query: string; parameters: Record<string, unknown> } {
	return { query: n1qlIndexAdvisor, parameters: { advise_statement: query } };
}

// ADVISOR() output shape varies across server versions (adviseinfo nesting, current_indexes vs
// current_used_indexes; recommended entries carry `index_statement` while current entries carry
// `index` -- both hold DDL, validated against the live Capella cluster). Walk the whole result and
// classify every DDL string by the nearest meaningful ancestor key instead of hardcoding one shape.
function extractAdvisorSections(result: unknown): AdvisorSections {
	const sections: AdvisorSections = { current: [], recommended: [], covering: [] };
	const push = (list: string[], value: string) => {
		if (!list.includes(value)) list.push(value);
	};
	const walk = (node: unknown, path: string[]): void => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item, path);
			return;
		}
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			// The CREATE guard keeps non-DDL `index` fields (e.g. an index NAME) out.
			const isDdl =
				typeof value === "string" &&
				(key === "index_statement" || (key === "index" && /^CREATE\s/i.test(value.trim())));
			if (isDdl && typeof value === "string") {
				if (path.some((p) => /covering/i.test(p))) push(sections.covering, value);
				else if (path.some((p) => /current/i.test(p))) push(sections.current, value);
				else push(sections.recommended, value);
				continue;
			}
			walk(value, [...path, key]);
		}
	};
	walk(result, []);
	return sections;
}

// Strip any leading EXPLAIN token (and trailing semicolon), then prepend exactly one. Ported
// verbatim from explainSqlPlusPlusQuery.ts (also ported locally into v2/tools/core.ts for
// capella_explain_sql_plus_plus_query -- same precedent applies here).
function buildExplainStatement(query: string): string {
	const trimmed = query.trim().replace(/;\s*$/, "");
	const inner = trimmed.replace(/^EXPLAIN\s+/i, "");
	return `EXPLAIN ${inner}`;
}

// SIO-1107: live analysis via the server-computed Index Advisor + EXPLAIN plan. Returns null when
// the cluster path yields nothing (both legs failed), so the caller can fall back to the offline
// regex heuristics. Ported verbatim from suggestQueryOptimizations.ts's runLiveOptimizationAnalysis.
async function runLiveOptimizationAnalysis(
	query: string,
	scopeName: string,
	bucket: Bucket,
	bucketName?: string,
): Promise<string | null> {
	const resolved = resolveBucket(bucket, bucketName);
	const scope = resolved.scope(scopeName);
	const { query: advisorStmt, parameters } = buildAdvisorQuery(query);

	// ADVISOR only evaluates the statement (never executes it), so it is always
	// safe. The EXPLAIN leg is skipped for mutations under readOnlyQueryMode to
	// keep the posture uniform with capella_explain_sql_plus_plus_query.
	const inner = query.trim().replace(/^EXPLAIN\s+/i, "");
	const parsed = sqlppParser.parse(inner);
	const skipExplain =
		config.server.readOnlyQueryMode && (sqlppParser.modifiesData(parsed) || sqlppParser.modifiesStructure(parsed));

	const [advisorRes, explainRes] = await Promise.allSettled([
		scope.query(advisorStmt, { parameters }).then((r) => r.rows),
		skipExplain
			? Promise.reject(new Error("EXPLAIN skipped for a mutation statement in read-only mode"))
			: scope.query(buildExplainStatement(query)).then((r) => r.rows),
	]);

	if (advisorRes.status !== "fulfilled" && explainRes.status !== "fulfilled") {
		logger.warn(
			{ advisorError: String(advisorRes.reason), explainError: String(explainRes.reason) },
			"Live optimization analysis unavailable; falling back to heuristics",
		);
		return null;
	}

	let text = "# Query Optimization Suggestions (live cluster analysis)\n\n";
	text += `## Original Query\n\n\`\`\`sql\n${query}\n\`\`\`\n\n`;

	if (advisorRes.status === "fulfilled") {
		const sections = extractAdvisorSections(advisorRes.value);
		text += "## Index Advisor (server-computed)\n\n";
		text += `- Current indexes used: ${sections.current.length}\n`;
		text += `- Recommended indexes: ${sections.recommended.length}\n`;
		text += `- Recommended covering indexes: ${sections.covering.length}\n\n`;
		const renderList = (title: string, statements: string[]) => {
			if (statements.length === 0) return "";
			return `### ${title}\n\n${statements.map((s) => `\`\`\`sql\n${s}\n\`\`\``).join("\n\n")}\n\n`;
		};
		text += renderList("Current Indexes Used", sections.current);
		text += renderList("Recommended Indexes", sections.recommended);
		text += renderList("Recommended Covering Indexes", sections.covering);
		if (sections.recommended.length + sections.covering.length === 0) {
			text += "The advisor returned no index recommendations -- existing indexes already serve this query.\n\n";
		}
	} else {
		text += `## Index Advisor (server-computed)\n\nUnavailable: ${String(advisorRes.reason)}\n\n`;
	}

	if (explainRes.status === "fulfilled") {
		const first = explainRes.value[0];
		const plan =
			first !== null && typeof first === "object" && "plan" in (first as Record<string, unknown>)
				? (first as Record<string, unknown>).plan
				: first;
		text += `## Execution Plan Analysis\n\n${formatPlanFindings(evaluateQueryPlan(plan))}\n\n`;
		text += "Run capella_explain_sql_plus_plus_query for the full plan JSON.\n";
	} else {
		text += `## Execution Plan Analysis\n\nUnavailable: ${String(explainRes.reason)}\n`;
	}

	return text;
}

// SIO-1058: Couchbase GSI has NO `INCLUDE (col-list)` covering clause (that is SQL Server syntax;
// only INCLUDE MISSING on the leading key exists). A covering index appends the projected fields
// as trailing index keys -- predicate keys first, then projected keys. Verified against the
// createindex.html grammar and the live cluster's own idx_article_required_fields_covered.
// Ported verbatim from suggestQueryOptimizations.ts.
function buildCoveringIndexDdl(
	bucket: string,
	scope: string,
	collection: string,
	indexFields: string[],
	coveringFields: string[],
): string {
	// SIO-1243: the caller's dedupe (`!indexFields.includes(cleanField)`) is an exact,
	// case-sensitive Array.includes comparing a PROJECTION string against entries derived from a
	// PREDICATE regex, so a quoting or casing divergence slips a repeat through
	// (`` `status` `` vs `status`, `Status` vs `status`); coveringFields is also never deduplicated
	// against itself. Couchbase rejects a duplicate index key, so enforce the invariant where the
	// list is actually built. First occurrence wins.
	//
	// Identity is backtick- and case-insensitive but NOT qualifier-stripping. An ALIAS-qualified
	// `o.status` and a bare `status` therefore stay distinct and a duplicate survives -- accepted
	// deliberately (CodeRabbit, PR #491). At this layer a dotted name is ambiguous: `o.status` is an
	// alias qualifier but `shipping.status` is a NESTED FIELD PATH, and telling them apart needs the
	// query's FROM aliases, which we do not have here. Stripping the prefix would collapse
	// `shipping.status` and `billing.status` into one key and silently DROP a real index key --
	// a wrong index, which is worse than a duplicate key that Couchbase rejects loudly and that
	// dedupeCreateIndexKeys (packages/agent) also catches downstream. Pinned by the
	// "keeps distinct nested field paths" test.
	const seen = new Set<string>();
	const allKeys = [...indexFields, ...coveringFields]
		.filter((key) => {
			const identity = key.replace(/`/g, "").trim().toLowerCase();
			if (identity.length === 0 || seen.has(identity)) return false;
			seen.add(identity);
			return true;
		})
		.join(", ");
	return `CREATE INDEX idx_covering ON \`${bucket}\`.\`${scope}\`.\`${collection}\`(${allKeys});`;
}

interface QueryAnalysis {
	queryType: string;
	predicates: string[];
	projectedFields: string[];
	orderByFields: string[];
	groupByFields: string[];
	joinClauses: string[];
	hasPagination: boolean;
	hasLimit: boolean;
	hasOffset: boolean;
	hasAggregate: boolean;
	usesPrimaryKey: boolean;
	complexityScore: number;
}

// Ported verbatim from suggestQueryOptimizations.ts.
function analyzeQuery(query: string): QueryAnalysis {
	const analysis: QueryAnalysis = {
		queryType: "SELECT", // Default
		predicates: [],
		projectedFields: [],
		orderByFields: [],
		groupByFields: [],
		joinClauses: [],
		hasPagination: false,
		hasLimit: false,
		hasOffset: false,
		hasAggregate: false,
		usesPrimaryKey: false,
		complexityScore: 0,
	};

	// Convert to uppercase for case-insensitive matching but preserve original for extraction
	const upperQuery = query.toUpperCase();

	// Determine query type
	if (upperQuery.includes("SELECT")) {
		analysis.queryType = "SELECT";
	} else if (upperQuery.includes("UPDATE")) {
		analysis.queryType = "UPDATE";
	} else if (upperQuery.includes("DELETE")) {
		analysis.queryType = "DELETE";
	} else if (upperQuery.includes("INSERT")) {
		analysis.queryType = "INSERT";
	} else if (upperQuery.includes("MERGE")) {
		analysis.queryType = "MERGE";
	}

	// Extract WHERE predicates
	const whereMatch = upperQuery.match(/WHERE\s+(.*?)(?:ORDER BY|GROUP BY|LIMIT|OFFSET|HAVING|$)/is);
	if (whereMatch?.[1]) {
		// Split by AND/OR and clean up
		const predicates = whereMatch[1]
			.split(/\s+(?:AND|OR)\s+/i)
			.map((p) => p.trim())
			.filter((p) => p.length > 0);

		analysis.predicates = predicates;

		// Check for META().id which indicates primary key usage
		if (whereMatch[1].toUpperCase().includes("META().ID") || whereMatch[1].includes("meta().id")) {
			analysis.usesPrimaryKey = true;
		}
	}

	// Extract projected fields
	const selectMatch = upperQuery.match(/SELECT\s+(.*?)\s+FROM/is);
	if (selectMatch?.[1]) {
		if (!selectMatch[1].includes("*")) {
			// Split by commas, but handle function calls carefully
			let inFunction = 0;
			let currentField = "";
			const projectedFields = [];

			for (let i = 0; i < selectMatch[1].length; i++) {
				const char = selectMatch[1][i];
				if (char === "(") inFunction++;
				if (char === ")") inFunction--;

				if (char === "," && inFunction === 0) {
					projectedFields.push(currentField.trim());
					currentField = "";
				} else {
					currentField += char;
				}
			}

			if (currentField.trim()) {
				projectedFields.push(currentField.trim());
			}

			analysis.projectedFields = projectedFields;

			// Check for aggregates
			const hasAggregate = projectedFields.some((f) => /\b(COUNT|SUM|AVG|MIN|MAX|ARRAY_AGG)\s*\(/i.test(f));
			analysis.hasAggregate = hasAggregate;
		}
	}

	// Extract ORDER BY fields
	const orderByMatch = upperQuery.match(/ORDER BY\s+(.*?)(?:LIMIT|OFFSET|$)/is);
	if (orderByMatch?.[1]) {
		const orderByFields = orderByMatch[1]
			.split(",")
			.map((f) => f.trim().split(/\s+/)[0] ?? "") // Remove ASC/DESC
			.filter((f): f is string => f.length > 0);

		analysis.orderByFields = orderByFields;
	}

	// Extract GROUP BY fields
	const groupByMatch = upperQuery.match(/GROUP BY\s+(.*?)(?:HAVING|ORDER BY|LIMIT|OFFSET|$)/is);
	if (groupByMatch?.[1]) {
		const groupByFields = groupByMatch[1]
			.split(",")
			.map((f) => f.trim())
			.filter((f) => f.length > 0);

		analysis.groupByFields = groupByFields;
	}

	// Check for JOIN clauses
	const joinMatches = upperQuery.match(/\b(JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN)\b/gi);
	if (joinMatches) {
		analysis.joinClauses = joinMatches;
	}

	// Check for pagination
	analysis.hasLimit = upperQuery.includes("LIMIT");
	analysis.hasOffset = upperQuery.includes("OFFSET");
	analysis.hasPagination = analysis.hasLimit || analysis.hasOffset;

	// Calculate complexity score (higher means more complex)
	analysis.complexityScore = 1; // Start with base score

	if (analysis.predicates.length > 0) analysis.complexityScore += analysis.predicates.length;
	if (analysis.orderByFields.length > 0) analysis.complexityScore += analysis.orderByFields.length;
	if (analysis.groupByFields.length > 0) analysis.complexityScore += analysis.groupByFields.length * 2;
	if (analysis.joinClauses.length > 0) analysis.complexityScore += analysis.joinClauses.length * 3;
	if (analysis.hasAggregate) analysis.complexityScore += 2;

	return analysis;
}

// Ported verbatim from suggestQueryOptimizations.ts.
function extractQueryComponents(query: string): {
	extractedBucket: string | null;
	extractedScope: string | null;
	extractedCollection: string | null;
} {
	// Default values
	let extractedBucket = null;
	let extractedScope = null;
	let extractedCollection = null;

	// Look for fully qualified path pattern: `bucket`.`scope`.`collection`
	const fqpMatch = query.match(/`([^`]+)`.`([^`]+)`.`([^`]+)`/);
	if (fqpMatch) {
		extractedBucket = fqpMatch[1] ?? null;
		extractedScope = fqpMatch[2] ?? null;
		extractedCollection = fqpMatch[3] ?? null;
	}

	// If not found, try different patterns
	if (!extractedBucket && !extractedScope && !extractedCollection) {
		// Try to find bucket and collection without scope: `bucket`.`collection` or FROM bucket.collection
		const bcMatch = query.match(/(?:FROM|JOIN)\s+(?:`([^`]+)`\.`([^`]+)`|([^`,\s]+)\.([^`,\s]+))/i);
		if (bcMatch) {
			if (bcMatch[1] && bcMatch[2]) {
				extractedBucket = bcMatch[1];
				extractedCollection = bcMatch[2];
			} else if (bcMatch[3] && bcMatch[4]) {
				extractedBucket = bcMatch[3];
				extractedCollection = bcMatch[4];
			}
		}
	}

	return { extractedBucket, extractedScope, extractedCollection };
}

// Ported verbatim from suggestQueryOptimizations.ts.
function formatOptimizationSuggestions(
	query: string,
	analysis: QueryAnalysis,
	bucket: string,
	scope: string,
	collection: string,
): string {
	let output = `# Query Optimization Suggestions\n\n`;

	// Show original query
	output += `## Original Query\n\n`;
	output += "```sql\n";
	output += query;
	output += "\n```\n\n";

	// Show analysis
	output += `## Query Analysis\n\n`;
	output += `- **Query Type:** ${analysis.queryType}\n`;
	output += `- **Complexity Score:** ${analysis.complexityScore} (higher = more complex)\n`;
	output += `- **Target:** \`${bucket}\`.\`${scope}\`.\`${collection}\`\n`;

	if (analysis.predicates.length > 0) {
		output += `- **WHERE Predicates:** ${analysis.predicates.length}\n`;
		analysis.predicates.forEach((p) => {
			output += `  - ${p}\n`;
		});
	}

	if (analysis.orderByFields.length > 0) {
		output += `- **ORDER BY Fields:** ${analysis.orderByFields.join(", ")}\n`;
	}

	if (analysis.groupByFields.length > 0) {
		output += `- **GROUP BY Fields:** ${analysis.groupByFields.join(", ")}\n`;
	}

	if (analysis.joinClauses.length > 0) {
		output += `- **Join Clauses:** ${analysis.joinClauses.length}\n`;
	}

	output += `- **Uses Pagination:** ${analysis.hasPagination ? "Yes" : "No"}\n`;
	output += `- **Uses Primary Key:** ${analysis.usesPrimaryKey ? "Yes" : "No"}\n`;
	output += `- **Has Aggregations:** ${analysis.hasAggregate ? "Yes" : "No"}\n\n`;

	// Index recommendations
	output += `## Index Recommendations\n\n`;

	// If using primary key, that's optimal for lookups
	if (analysis.usesPrimaryKey && analysis.predicates.length === 1) {
		output += `- **Primary Index:** This query uses META().id for lookups, which is optimal for retrieving documents by ID.\n\n`;
	} else {
		// Generate index recommendations based on predicates and sort
		const indexableFields = new Set<string>();

		// Extract fields from predicates
		analysis.predicates.forEach((p) => {
			// Extract field name (assumes format like "field = value" or "field IN [...]")
			const fieldMatch = p.match(
				/([a-zA-Z0-9_.]+)\s*(?:=|!=|<|>|<=|>=|IN|LIKE|NOT LIKE|NOT NULL|IS NULL|IS NOT NULL)/i,
			);
			if (fieldMatch?.[1]) {
				indexableFields.add(fieldMatch[1].trim());
			}
		});

		// Add ORDER BY fields
		analysis.orderByFields.forEach((field) => {
			indexableFields.add(field);
		});

		// Add GROUP BY fields
		analysis.groupByFields.forEach((field) => {
			indexableFields.add(field);
		});

		// Convert to array and remove any meta().id (already addressed)
		const indexFields = Array.from(indexableFields).filter((f) => !f.toLowerCase().includes("meta().id"));

		if (indexFields.length > 0) {
			output += `### Recommended Index Statements\n\n`;

			// Simple index for each predicate field
			indexFields.forEach((field) => {
				const safeField = field.replace(/\./g, "_");
				output += `\`\`\`sql\n`;
				output += `CREATE INDEX idx_${safeField} ON \`${bucket}\`.\`${scope}\`.\`${collection}\`(${field});\n`;
				output += `\`\`\`\n\n`;
			});

			// Composite index if multiple fields are used
			if (indexFields.length > 1) {
				// Create a composite index based on potential access patterns
				let compositeIndexFields = "";

				// Priority order: equality predicates, then range predicates, then ORDER BY/GROUP BY
				// For simplicity, we'll just use the fields as-is
				compositeIndexFields = indexFields.join(", ");

				const safeIndexName = `idx_composite_${indexFields.map((f) => f.replace(/\./g, "_")).join("_")}`;

				output += `### Composite Index (Covers Multiple Fields)\n\n`;
				output += `\`\`\`sql\n`;
				output += `CREATE INDEX ${safeIndexName} ON \`${bucket}\`.\`${scope}\`.\`${collection}\`(${compositeIndexFields});\n`;
				output += `\`\`\`\n\n`;
			}

			// Covering index if appropriate
			if (analysis.projectedFields.length > 0 && !analysis.projectedFields.includes("*")) {
				// Get projected fields that aren't already in our index
				const coveringFields = analysis.projectedFields.filter((field) => {
					// Extract field name from projections (handles aliases like "field AS alias")
					const cleanField = (field.split(/\s+AS\s+/i)[0] ?? "").trim();
					// Remove function calls
					if (cleanField.includes("(")) return false;
					// Only include if not already in index fields
					return !indexFields.includes(cleanField);
				});

				if (coveringFields.length > 0 && indexFields.length > 0) {
					output += `### Covering Index (Includes Projected Fields)\n\n`;
					output += `\`\`\`sql\n`;
					output += `${buildCoveringIndexDdl(bucket, scope, collection, indexFields, coveringFields)}\n`;
					output += `\`\`\`\n\n`;
					output += `A covering index includes all query fields as index keys (predicate keys first, then projected keys), eliminating the document fetch.\n\n`;
				}
			}
		} else {
			output += `No specific index recommendations based on the query. Consider adding a primary index if one doesn't exist:\n\n`;
			output += `\`\`\`sql\n`;
			output += `CREATE PRIMARY INDEX ON \`${bucket}\`.\`${scope}\`.\`${collection}\`;\n`;
			output += `\`\`\`\n\n`;
		}
	}

	// Query optimization suggestions
	output += `## Query Optimization Suggestions\n\n`;

	// Suggest improvements based on analysis
	const suggestions = [];

	// Check for missing LIMIT
	if (!analysis.hasLimit) {
		suggestions.push(
			"**Add LIMIT Clause:** Consider adding a LIMIT clause to prevent returning too many results, which can impact performance.",
		);
	}

	// Check for wildcard projections
	if (analysis.projectedFields.length === 0) {
		suggestions.push(
			"**Avoid SELECT * Projections:** Specify only the fields you need instead of using SELECT * to reduce network traffic and improve performance.",
		);
	}

	// Check for high complexity
	if (analysis.complexityScore > 10) {
		suggestions.push(
			"**Consider Query Splitting:** This query has high complexity. Consider breaking it into multiple simpler queries if possible.",
		);
	}

	// Check for efficient predicate usage
	if (analysis.predicates.length > 2) {
		suggestions.push(
			"**Optimize Predicates:** Ensure the most selective predicates (those that filter out the most documents) are listed first in your WHERE clause.",
		);
	}

	// Check for efficient join usage
	if (analysis.joinClauses.length > 0) {
		suggestions.push(
			"**Optimize Joins:** Ensure smaller datasets are on the right side of the join. Consider using NEST or UNNEST for array relationships instead of JOIN when appropriate.",
		);
	}

	// Suggestion for prepared statements
	suggestions.push(
		"**Use Prepared Statements:** If this query is executed frequently with different parameters, use prepared statements to improve performance.",
	);

	// Add suggestions to output
	if (suggestions.length > 0) {
		suggestions.forEach((suggestion) => {
			output += `- ${suggestion}\n\n`;
		});
	} else {
		output += "No specific optimization suggestions for this query.\n\n";
	}

	// Add EXPLAIN suggestion
	output += `## Next Steps\n\n`;
	output += `To further analyze this query against the live cluster:\n\n`;
	output += `- Run capella_explain_sql_plus_plus_query to see the real execution plan and whether indexes cover the projection.\n`;
	output += `- Run capella_get_index_advisor_recommendations for server-computed index DDL.\n`;

	return output;
}
