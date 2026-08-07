// src/v2/tools/query-analysis-a.ts
//
// SIO-1443: v2 port of the first alphabetical half (11 of 21) of the query-analysis tools --
// pure SQL++ reads against Couchbase's system catalogs (system:completed_requests,
// system:indexes, system:prepareds). Re-implemented against @modelcontextprotocol/server's
// registerTool config style -- v1's tool files (packages/mcp-server-couchbase/src/tools/queryAnalysis/*.ts)
// import McpServer from @modelcontextprotocol/sdk, a different package, so they are read as
// reference only, not imported. Handler bodies, buildQuery logic, and Zod schemas are ported
// verbatim; only the server/registration plumbing changes. Annotations are hand-written per tool
// below (see tool-classification.ts's READ_ONLY_TOOLS Set -- all 11 tools here are plain reads,
// none are in WRITE_TOOLS/DESTRUCTIVE_TOOLS) since couchbaseToolAnnotations() itself is v1-only
// (imports ToolAnnotations from the v1 SDK's types module).
//
// Shared query-execution helper: v1's queryAnalysisUtils.ts (executeAnalysisQuery,
// executeAnalysisQueryStructured, buildAnalysisErrorResponse) and analysisQueries.ts (the N1QL
// string constants) are BOTH SDK-agnostic -- they import only `couchbase`, `@devops-agent/shared`,
// and local lib/utils modules, never `@modelcontextprotocol/sdk`. Imported directly here rather
// than ported, so the underlying SQL++ stays byte-identical between v1 and v2 by construction.
// Task 5 (query-analysis-b.ts, the other 10 tools) should make the SAME import decision.
//
// SIO-1443 (reviewer follow-up): formatAdvisorResult (capella_get_index_advisor_recommendations's
// formatter, which internally calls getIndexAdvisor.ts's own extractAdvisorSections) is likewise
// imported directly from getIndexAdvisor.ts rather than re-ported as a local copy -- that file's
// only @modelcontextprotocol/sdk reference is `import type { McpServer }`, erased at compile time,
// same reasoning as core.ts's adviseQuery import. Closes the duplicated-logic risk the original
// port introduced by hand-copying these helpers here (and again in query-analysis-b.ts).
//
// Hidden-gate check (SIO-1443 lesson from Tasks 2/3): none of these 11 tools gate on a config
// flag or feature flag the way capella_run_sql_plus_plus_query gates on
// config.server.readOnlyQueryMode (see core.ts's sqlQueryAnnotations/runQuery). They are plain
// SELECT-only system-catalog queries with no resource-registry dependency and no conditional
// directory-probe/config-enabled branch anywhere in their v1 handler bodies -- confirmed by
// reading all 11 reference files in full. No gate to close here.

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer, RegisteredTool, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { classifyCouchbaseError, summarizeCouchbaseError } from "../../lib/classifyCouchbaseError";
import { connectionManager } from "../../lib/connectionManager";
import { assertIdentifier } from "../../lib/identifiers";
import { resolveBucket } from "../../lib/resolveBucket";
import {
	DEFAULT_ANALYSIS_LIMIT,
	detailedIndexesQuery,
	detailedPreparedStatementsQuery,
	documentTypeExamples,
	n1qlCompletedRequests,
	n1qlIndexAdvisor,
	n1qlIndexesToDrop,
	n1qlLargestResultCountQueries,
	n1qlLargestResultSizeQueries,
	n1qlLongestRunningQueries,
	n1qlQueryFatalRequests,
} from "../../tools/queryAnalysis/analysisQueries";
import { formatAdvisorResult } from "../../tools/queryAnalysis/getIndexAdvisor";
import {
	buildAnalysisErrorResponse,
	executeAnalysisQuery,
	executeAnalysisQueryStructured,
} from "../../tools/queryAnalysis/queryAnalysisUtils";
import { logger } from "../../utils/logger";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };

// Ported verbatim from getFatalRequests.ts / getCompletedRequests.ts -- shared period-window
// rewrite over the DATE_ADD_STR(NOW_STR(), ...) literal. Closed switch over a Zod enum, so the
// replacement string never includes user input.
function applyPeriod(query: string, period?: "day" | "week" | "month" | "quarter"): string {
	if (!period) return query;
	let periodValue: number;
	let periodUnit: string;
	switch (period) {
		case "day":
			periodValue = 1;
			periodUnit = "day";
			break;
		case "week":
			periodValue = 1;
			periodUnit = "week";
			break;
		case "month":
			periodValue = 1;
			periodUnit = "month";
			break;
		case "quarter":
			periodValue = 3;
			periodUnit = "month";
			break;
	}
	return query.replace(
		/DATE_ADD_STR\(NOW_STR\(\), -\d+, '\w+'\)/,
		`DATE_ADD_STR(NOW_STR(), -${periodValue}, '${periodUnit}')`,
	);
}

export function registerQueryAnalysisToolsAV2(server: McpServer, tools: Map<string, RegisteredTool>): void {
	// capella_analyze_document_structure -- ported verbatim from analyzeDocumentStructure.ts.
	const analyzeDocumentStructure = server.registerTool(
		"capella_analyze_document_structure",
		{
			description: "Analyze the structure of a document type",
			inputSchema: z.object({
				document_key: z.string().describe("Document key to analyze"),
				scope_name: z.string().optional().default("_default").describe("Scope name"),
				collection_name: z.string().optional().default("_default").describe("Collection name"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ document_key, scope_name, collection_name }) => {
			logger.info({ document_key, scope_name, collection_name }, "Analyzing document structure");
			const bucket = await connectionManager.getConnection();
			try {
				const collection = bucket.scope(scope_name).collection(collection_name);
				const result = await collection.get(document_key);
				const document = result.content;
				const analysis = analyzeStructure(document);
				return { content: [{ type: "text" as const, text: formatAnalysis(document_key, document, analysis) }] };
			} catch (error) {
				logger.error({ error: summarizeCouchbaseError(error) }, "Error analyzing document structure");
				const message = error instanceof Error ? error.message : String(error);
				return buildAnalysisErrorResponse(error, `Error analyzing document structure: ${message}`);
			}
		},
	);
	tools.set("capella_analyze_document_structure", analyzeDocumentStructure);

	// capella_get_completed_requests -- ported verbatim from getCompletedRequests.ts.
	const getCompletedRequests = server.registerTool(
		"capella_get_completed_requests",
		{
			description: "Get recent completed query requests with detailed execution information",
			inputSchema: z.object({
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
				period: z
					.enum(["day", "week", "month", "quarter"])
					.optional()
					.describe("Time period to analyze (day, week, month, quarter)"),
				status: z.enum(["success", "fatal", "timeout", "all"]).optional().describe("Filter by request status"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (input) => {
			logger.info(input, "Getting completed requests");
			const bucket = await connectionManager.getConnection();
			const { limit, period, status } = input;
			const parameters: Record<string, unknown> = {};
			let query = applyPeriod(n1qlCompletedRequests, period);

			if (status && status !== "all") {
				query = query.includes("WHERE")
					? query.replace(/WHERE/, "WHERE state = $status AND")
					: query.replace(/ORDER BY/, "WHERE state = $status ORDER BY");
				parameters.status = status;
			}

			const effectiveLimit = limit && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_ANALYSIS_LIMIT;
			query = query.includes("LIMIT")
				? query.replace(/LIMIT \d+/i, `LIMIT ${effectiveLimit}`)
				: `${query.replace(";", "")} LIMIT ${effectiveLimit};`;

			return executeAnalysisQuery(bucket, query, "Completed Query Requests", limit, parameters);
		},
	);
	tools.set("capella_get_completed_requests", getCompletedRequests);

	// capella_get_detailed_indexes -- ported verbatim from getDetailedIndexes.ts.
	const getDetailedIndexes = server.registerTool(
		"capella_get_detailed_indexes",
		{
			description: "Get detailed information about all indexes in the Couchbase system",
			inputSchema: z.object({
				bucket_name: z.string().optional().describe("Filter by bucket name"),
				scope_name: z.string().optional().describe("Filter by scope name"),
				collection_name: z.string().optional().describe("Filter by collection name"),
				state: z.string().optional().describe("Filter by state (e.g., 'online', 'deferred')"),
				has_condition: z.boolean().optional().describe("Filter for indexes with conditions"),
				is_primary: z.boolean().optional().describe("Filter for primary indexes only"),
				index_type: z.string().optional().describe("Filter by index type (e.g., 'GSI', 'FTS')"),
				sort_by: z
					.enum(["name", "state", "keyspace_id", "last_scan_time"])
					.optional()
					.default("keyspace_id")
					.describe("Sort results by field"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (input) => {
			logger.info(input, "Getting detailed indexes information");
			const bucket = await connectionManager.getConnection();
			const { bucket_name, scope_name, collection_name, state, has_condition, is_primary, index_type, sort_by } = input;
			const whereClauses: string[] = [];
			const parameters: Record<string, unknown> = {};

			if (bucket_name) {
				whereClauses.push("(t.bucket_id = $bucket_name OR t.keyspace_id = $bucket_name)");
				parameters.bucket_name = bucket_name;
			}
			if (scope_name) {
				whereClauses.push("t.scope_id = $scope_name");
				parameters.scope_name = scope_name;
			}
			if (collection_name) {
				whereClauses.push("t.keyspace_id = $collection_name");
				parameters.collection_name = collection_name;
			}
			if (state) {
				whereClauses.push("t.state = $state");
				parameters.state = state;
			}
			if (has_condition === true) {
				whereClauses.push("t.condition IS NOT NULL");
			} else if (has_condition === false) {
				whereClauses.push("t.condition IS NULL");
			}
			if (is_primary === true) {
				whereClauses.push("t.is_primary = true");
			} else if (is_primary === false) {
				whereClauses.push("(t.is_primary IS MISSING OR t.is_primary = false)");
			}
			if (index_type) {
				whereClauses.push("LOWER(t.`using`) = LOWER($index_type)");
				parameters.index_type = index_type;
			}

			let orderByField: string;
			switch (sort_by) {
				case "name":
					orderByField = "t.name";
					break;
				case "state":
					orderByField = "t.state";
					break;
				case "last_scan_time":
					orderByField = "t.metadata.last_scan_time";
					break;
				default:
					orderByField = "t.keyspace_id, t.name";
					break;
			}

			const whereFragment = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
			const query = detailedIndexesQuery
				.replace("/* WHERE_CLAUSES */", whereFragment)
				.replace("/* ORDER_BY */", orderByField);

			return executeAnalysisQuery(bucket, query, "Detailed Index Information", undefined, parameters);
		},
	);
	tools.set("capella_get_detailed_indexes", getDetailedIndexes);

	// capella_get_detailed_prepared_statements -- ported verbatim from getDetailedPreparedStatements.ts.
	const getDetailedPreparedStatements = server.registerTool(
		"capella_get_detailed_prepared_statements",
		{
			description: "Get detailed information about prepared statements with usage statistics",
			inputSchema: z.object({
				limit: z.number().optional().describe("Optional limit for the number of results to return"),
				node_filter: z.string().optional().describe("Filter by node name (e.g., 'node1.example.com:8091')"),
				query_pattern: z.string().optional().describe("Filter by query pattern (e.g., 'SELECT')"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (input) => {
			logger.info(input, "Getting detailed prepared statements");
			const bucket = await connectionManager.getConnection();
			const { limit, node_filter, query_pattern } = input;
			const whereClauses: string[] = [];
			const parameters: Record<string, unknown> = {};

			if (node_filter) {
				whereClauses.push("node LIKE $node_pattern");
				parameters.node_pattern = `%${node_filter}%`;
			}
			if (query_pattern) {
				whereClauses.push("statement LIKE $query_pattern_like");
				parameters.query_pattern_like = `%${query_pattern}%`;
			}

			let query = detailedPreparedStatementsQuery;
			if (whereClauses.length > 0) {
				const whereFragment = `WHERE ${whereClauses.join(" AND ")}`;
				query = query.includes("ORDER BY")
					? query.replace(/ORDER BY/i, `${whereFragment} ORDER BY`)
					: query.replace(";", ` ${whereFragment};`);
			}

			if (limit && Number.isInteger(limit) && limit > 0) {
				query = query.includes("LIMIT")
					? query.replace(/LIMIT \d+/i, `LIMIT ${limit}`)
					: query.replace(";", ` LIMIT ${limit};`);
			}

			return executeAnalysisQuery(bucket, query, "Prepared Statements Analysis", limit, parameters);
		},
	);
	tools.set("capella_get_detailed_prepared_statements", getDetailedPreparedStatements);

	// capella_get_document_type_examples -- ported verbatim from getDocumentTypeExamples.ts.
	const getDocumentTypeExamples = server.registerTool(
		"capella_get_document_type_examples",
		{
			description: "Get examples of document keys for each document type",
			inputSchema: z.object({
				scope_name: z
					.string()
					.optional()
					.default("_default")
					.describe("Scope name to query (must match /^[A-Za-z0-9_][A-Za-z0-9_%-]*$/)"),
				collection_name: z
					.string()
					.optional()
					.default("_default")
					.describe("Collection name to query, hyphens allowed (must match /^[A-Za-z0-9_][A-Za-z0-9_%-]*$/)"),
				type_field: z
					.string()
					.optional()
					.default("documentType")
					.describe("Field name that contains the document type (must match /^[A-Za-z0-9_][A-Za-z0-9_%-]*$/)"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (input) => {
			logger.info(input, "Getting document type examples");
			const bucket = await connectionManager.getConnection();

			// SIO-667: scope/collection/type_field are spliced as backtick-wrapped IDENTIFIERS, not
			// literals -- N1QL named parameters can't bind identifiers, so the only safe option is
			// whitelist validation before substitution.
			const scope_name = assertIdentifier(input.scope_name, "scope_name");
			const collection_name = assertIdentifier(input.collection_name, "collection_name");
			const type_field = assertIdentifier(input.type_field, "type_field");

			let query: string = documentTypeExamples;
			if (scope_name !== "_default" || collection_name !== "_default") {
				query = query.replace(
					/FROM\s+default\._default\._default/,
					`FROM default.\`${scope_name}\`.\`${collection_name}\``,
				);
			}
			if (type_field !== "documentType") {
				query = query.replace(/d\.documentType/g, `d.\`${type_field}\``);
			}

			return executeAnalysisQuery(bucket, query, "Document Type Examples", undefined, {});
		},
	);
	tools.set("capella_get_document_type_examples", getDocumentTypeExamples);

	// capella_get_fatal_requests -- ported verbatim from getFatalRequests.ts.
	const getFatalRequests = server.registerTool(
		"capella_get_fatal_requests",
		{
			description: "Get information about failed/fatal N1QL queries",
			inputSchema: z.object({
				period: z
					.enum(["day", "week", "month", "quarter"])
					.optional()
					.describe("Time period to analyze (day, week, month, quarter)"),
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ period, limit }) => {
			logger.info({ period, limit }, "Getting fatal query requests");
			const bucket = await connectionManager.getConnection();
			let query = applyPeriod(n1qlQueryFatalRequests, period);
			const effectiveLimit = limit && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_ANALYSIS_LIMIT;
			query = query.replace("ORDER BY requestTime DESC;", `ORDER BY requestTime DESC LIMIT ${effectiveLimit};`);
			return executeAnalysisQuery(bucket, query, "Fatal Query Requests", limit);
		},
	);
	tools.set("capella_get_fatal_requests", getFatalRequests);

	// capella_get_index_advisor_recommendations -- ported verbatim from getIndexAdvisor.ts.
	const getIndexAdvisorRecommendations = server.registerTool(
		"capella_get_index_advisor_recommendations",
		{
			description:
				"Run the server-computed Couchbase Index Advisor (SELECT ADVISOR) on a SQL++ query and return current, recommended, and covering index DDL. Evaluates only -- never creates indexes.",
			inputSchema: z.object({
				scope_name: z.string().describe("Name of the scope to analyze the query in"),
				query: z
					.string()
					.describe("SQL++ query to analyze. Use only the collection name in the FROM clause (scope context)."),
				bucket_name: z.string().optional().describe("Optional bucket name (defaults to the configured bucket)"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (params) => {
			logger.info({ scope: params.scope_name, bucket: params.bucket_name }, "Running index advisor");
			const bucket = await connectionManager.getConnection();
			const { scope_name, query, bucket_name } = params;
			// The analyzed statement binds as $advise_statement -- injection-closed by construction
			// (SIO-667 posture; mirrors the official Python server).
			const parameters: Record<string, unknown> = { advise_statement: query };
			try {
				const resolved = resolveBucket(bucket, bucket_name);
				const result = await resolved.scope(scope_name).query(n1qlIndexAdvisor, { parameters });
				const rows = await result.rows;
				return { content: [{ type: "text" as const, text: formatAdvisorResult(query, rows) }] };
			} catch (error) {
				logger.error({ error }, "Index advisor query failed");
				const message = error instanceof Error ? error.message : String(error);
				const kind = classifyCouchbaseError(error);
				const envelope = buildToolErrorEnvelope({ kind, message: `Index advisor failed: ${message}` });
				return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
			}
		},
	);
	tools.set("capella_get_index_advisor_recommendations", getIndexAdvisorRecommendations);

	// capella_get_indexes_to_drop -- ported verbatim from getIndexesToDrop.ts.
	const getIndexesToDrop = server.registerTool(
		"capella_get_indexes_to_drop",
		{
			description: "Get indexes that might be candidates for removal (never scanned)",
			inputSchema: z.object({
				bucket_filter: z.string().optional().describe("Optional filter for bucket names (comma-separated)"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ bucket_filter }) => {
			logger.info({ bucket_filter }, "Getting indexes that are candidates for removal");
			const bucket = await connectionManager.getConnection();

			let query = n1qlIndexesToDrop;
			const parameters: Record<string, unknown> = {};

			const buckets = bucket_filter
				? bucket_filter
						.split(",")
						.map((b) => b.trim())
						.filter(Boolean)
				: [];

			if (buckets.length > 0) {
				const placeholders = buckets.map((_, i) => `$b${i}`);
				for (const [i, value] of buckets.entries()) {
					parameters[`b${i}`] = value;
				}
				// Both `ANY v IN [...]` literals (inner sub-SELECT and outer WHERE) get the same
				// placeholder list -- they need to filter by the same bucket set.
				query = n1qlIndexesToDrop.replace(/ANY v IN \[.*?\]/g, `ANY v IN [${placeholders.join(", ")}]`);
			}

			return executeAnalysisQuery(
				bucket,
				query,
				"Indexes That Could Be Dropped (Never Scanned)",
				undefined,
				parameters,
			);
		},
	);
	tools.set("capella_get_indexes_to_drop", getIndexesToDrop);

	// capella_get_largest_result_count_queries -- ported verbatim from getLargestResultCountQueries.ts.
	const getLargestResultCountQueries = server.registerTool(
		"capella_get_largest_result_count_queries",
		{
			description: "Get queries that return the largest number of results",
			inputSchema: z.object({
				limit: z.number().optional().describe("Optional limit for the number of results to return"),
				min_count: z.number().optional().describe("Minimum result count to include"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ limit, min_count }) => {
			logger.info({ limit, min_count }, "Getting largest result count queries");
			const bucket = await connectionManager.getConnection();

			let query = n1qlLargestResultCountQueries;
			if (min_count && min_count > 0) {
				query = query.replace(
					"LETTING avgResultCount = AVG(resultCount)",
					`LETTING avgResultCount = AVG(resultCount)
           HAVING avgResultCount >= ${min_count}`,
				);
			}
			if (limit && Number.isInteger(limit) && limit > 0) {
				query = query.includes("LIMIT")
					? query.replace(/LIMIT \d+/i, `LIMIT ${limit}`)
					: `${query.replace(";", "")} LIMIT ${limit};`;
			}

			return executeAnalysisQuery(bucket, query, "Queries with Largest Result Counts", limit);
		},
	);
	tools.set("capella_get_largest_result_count_queries", getLargestResultCountQueries);

	// capella_get_largest_result_size_queries -- ported verbatim from getLargestResultSizeQueries.ts.
	const getLargestResultSizeQueries = server.registerTool(
		"capella_get_largest_result_size_queries",
		{
			description: "Get queries that return the largest result sizes in bytes",
			inputSchema: z.object({
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
				min_size_kb: z.number().optional().describe("Minimum result size in KB to include"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ limit, min_size_kb }) => {
			logger.info({ limit, min_size_kb }, "Getting largest result size queries");
			const bucket = await connectionManager.getConnection();

			let query = n1qlLargestResultSizeQueries;
			if (min_size_kb && min_size_kb > 0) {
				const minSizeBytes = min_size_kb * 1000;
				query = query.replace(
					"LETTING avgResultSize = AVG(resultSize)",
					`LETTING avgResultSize = AVG(resultSize)
           HAVING avgResultSize >= ${minSizeBytes}`,
				);
			}
			if (limit && Number.isInteger(limit) && limit > 0) {
				query = query.includes("LIMIT")
					? query.replace(/LIMIT \d+/i, `LIMIT ${limit}`)
					: `${query.replace(";", "")} LIMIT ${limit};`;
			}

			return executeAnalysisQuery(bucket, query, "Queries with Largest Result Sizes", limit);
		},
	);
	tools.set("capella_get_largest_result_size_queries", getLargestResultSizeQueries);

	// capella_get_longest_running_queries -- ported verbatim from getLongestRunningQueries.ts.
	// Uses executeAnalysisQueryStructured (bare JSON), NOT executeAnalysisQuery, matching v1.
	const getLongestRunningQueries = server.registerTool(
		"capella_get_longest_running_queries",
		{
			description:
				"Get the longest running queries based on service time. Returns bare JSON array of {statement, avgServiceTime, lastExecutionTime, queries} -- machine-readable for correlation extractors.",
			inputSchema: z.object({
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
				min_time_ms: z.number().optional().describe("Minimum execution time in milliseconds to include"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ limit, min_time_ms }) => {
			logger.info({ limit, min_time_ms }, "Getting longest running queries");
			const bucket = await connectionManager.getConnection();

			let query = n1qlLongestRunningQueries;
			if (min_time_ms && min_time_ms > 0) {
				query = query.replace(
					"LETTING avgServiceTime = AVG(STR_TO_DURATION(serviceTime))",
					`LETTING avgServiceTime = AVG(STR_TO_DURATION(serviceTime))
           HAVING avgServiceTime >= ${min_time_ms}000000`, // Convert ms to ns for N1QL
				);
			}
			if (limit && Number.isInteger(limit) && limit > 0) {
				query = query.includes("LIMIT")
					? query.replace(/LIMIT \d+/i, `LIMIT ${limit}`)
					: `${query.replace(";", "")} LIMIT ${limit};`;
			}

			return executeAnalysisQueryStructured(bucket, query);
		},
	);
	tools.set("capella_get_longest_running_queries", getLongestRunningQueries);
}

// ---- capella_analyze_document_structure helpers (ported verbatim from analyzeDocumentStructure.ts) ----

interface StructureAnalysis {
	fieldCount: number;
	depth: number;
	arrayFields: string[];
	objectFields: string[];
	primitiveFields: { [key: string]: string };
	nullFields: string[];
	nestedCollections: { [key: string]: number };
	sizeEstimate: number;
}

function analyzeStructure(document: Record<string, unknown>): StructureAnalysis {
	const analysis: StructureAnalysis = {
		fieldCount: 0,
		depth: 0,
		arrayFields: [],
		objectFields: [],
		primitiveFields: {},
		nullFields: [],
		nestedCollections: {},
		sizeEstimate: 0,
	};

	function analyzeField(path: string, value: unknown, depth: number): void {
		analysis.fieldCount++;
		analysis.depth = Math.max(analysis.depth, depth);

		if (value === null) {
			analysis.nullFields.push(path);
		} else if (Array.isArray(value)) {
			analysis.arrayFields.push(path);
			analysis.nestedCollections[path] = value.length;
			value.forEach((item, index) => {
				analyzeField(`${path}[${index}]`, item, depth + 1);
			});
		} else if (typeof value === "object") {
			analysis.objectFields.push(path);
			Object.entries(value as Record<string, unknown>).forEach(([key, val]) => {
				analyzeField(`${path}.${key}`, val, depth + 1);
			});
		} else {
			analysis.primitiveFields[path] = typeof value;
			if (typeof value === "string") {
				analysis.sizeEstimate += value.length * 2; // UTF-16 chars
			} else if (typeof value === "number") {
				analysis.sizeEstimate += 8; // Assuming double (64 bits)
			} else if (typeof value === "boolean") {
				analysis.sizeEstimate += 1;
			}
		}
	}

	Object.entries(document).forEach(([key, value]) => {
		analyzeField(key, value, 1);
	});
	analysis.sizeEstimate += Object.keys(document).length * 24; // key references etc.

	return analysis;
}

function formatAnalysis(documentKey: string, document: Record<string, unknown>, analysis: StructureAnalysis): string {
	let output = `# Document Structure Analysis: ${documentKey}\n\n`;

	output += `## Basic Statistics\n\n`;
	output += `- **Total Fields:** ${analysis.fieldCount}\n`;
	output += `- **Maximum Nesting Depth:** ${analysis.depth}\n`;
	output += `- **Number of Arrays:** ${analysis.arrayFields.length}\n`;
	output += `- **Number of Nested Objects:** ${analysis.objectFields.length}\n`;
	output += `- **Number of Primitive Fields:** ${Object.keys(analysis.primitiveFields).length}\n`;
	output += `- **Estimated Size:** ~${Math.round(analysis.sizeEstimate / 1024)} KB\n\n`;

	output += `## Document Overview\n\n`;
	output += "```json\n";
	output += JSON.stringify(document, null, 2);
	output += "\n```\n\n";

	output += `## Field Type Breakdown\n\n`;

	if (analysis.objectFields.length > 0) {
		output += `### Nested Objects (${analysis.objectFields.length})\n\n`;
		analysis.objectFields.forEach((field) => {
			output += `- \`${field}\`\n`;
		});
		output += "\n";
	}

	if (analysis.arrayFields.length > 0) {
		output += `### Arrays (${analysis.arrayFields.length})\n\n`;
		analysis.arrayFields.forEach((field) => {
			const count = analysis.nestedCollections[field] || 0;
			output += `- \`${field}\` - contains ${count} items\n`;
		});
		output += "\n";
	}

	if (Object.keys(analysis.primitiveFields).length > 0) {
		output += `### Primitive Fields (${Object.keys(analysis.primitiveFields).length})\n\n`;
		Object.entries(analysis.primitiveFields).forEach(([field, type]) => {
			output += `- \`${field}\`: ${type}\n`;
		});
		output += "\n";
	}

	if (analysis.nullFields.length > 0) {
		output += `### Null Fields (${analysis.nullFields.length})\n\n`;
		analysis.nullFields.forEach((field) => {
			output += `- \`${field}\`\n`;
		});
		output += "\n";
	}

	output += `## Indexing Recommendations\n\n`;
	output += `Based on document structure analysis, consider the following indexes:\n\n`;

	const potentialIndexFields = Object.entries(analysis.primitiveFields)
		.filter(
			([field, type]) =>
				type === "string" &&
				!field.includes("[") && // Skip array elements
				field.split(".").length <= 2, // Top-level or one level nested
		)
		.map(([field]) => field);

	if (potentialIndexFields.length > 0) {
		output += `### Potential Index Fields\n\n`;
		potentialIndexFields.forEach((field) => {
			output += `- \`${field}\`: CREATE INDEX idx_${field.replace(/\./g, "_")} ON \`default\`.\`${documentKey.split(":")[0]}\` (${field});\n`;
		});
		output += "\n";
	}

	output += `## Performance Considerations\n\n`;

	if (analysis.depth > 5) {
		output += `- **Deep Nesting:** Document has deep nesting (${analysis.depth} levels), which may impact query performance for deeply nested fields.\n`;
	}

	if (analysis.arrayFields.length > 0) {
		output += `- **Arrays:** Document contains ${analysis.arrayFields.length} arrays. Consider using UNNEST for efficient querying of array elements.\n`;
	}

	if (analysis.fieldCount > 50) {
		output += `- **Large Field Count:** Document has ${analysis.fieldCount} fields, which may increase overhead. Consider if all fields are necessary.\n`;
	}

	const largeArrays = Object.entries(analysis.nestedCollections)
		.filter(([_, count]) => count > 100)
		.map(([field, count]) => `${field} (${count} items)`);

	if (largeArrays.length > 0) {
		output += `- **Large Arrays:** Document contains large arrays that might impact performance: ${largeArrays.join(", ")}.\n`;
	}

	return output;
}

// capella_get_index_advisor_recommendations' formatAdvisorResult (and the extractAdvisorSections
// it depends on internally) is imported directly from getIndexAdvisor.ts (see the import block
// above) rather than re-ported locally -- getIndexAdvisor.ts's only @modelcontextprotocol/sdk
// reference is `import type { McpServer }`, erased at compile time, so it is safely importable at
// runtime. Closes one of the query-analysis helper triplication risks flagged in review
// (SIO-1443).
