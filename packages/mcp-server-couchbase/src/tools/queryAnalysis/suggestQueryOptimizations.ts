/* src/tools/queryAnalysis/suggestQueryOptimizations.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { config } from "../../config";
import { evaluateQueryPlan, formatPlanFindings } from "../../lib/queryPlan";
import { resolveBucket } from "../../lib/resolveBucket";
import { sqlppParser } from "../../lib/sqlppParser";
import { logger } from "../../utils/logger";
import { buildExplainStatement } from "../explainSqlPlusPlusQuery";
import { buildQuery as buildAdvisorQuery, extractAdvisorSections } from "./getIndexAdvisor";

// SIO-1058: Couchbase GSI has NO `INCLUDE (col-list)` covering clause (that is SQL Server syntax;
// only INCLUDE MISSING on the leading key exists). A covering index appends the projected fields
// as trailing index keys -- predicate keys first, then projected keys. Verified against the
// createindex.html grammar and the live cluster's own idx_article_required_fields_covered.
export function buildCoveringIndexDdl(
	bucket: string,
	scope: string,
	collection: string,
	indexFields: string[],
	coveringFields: string[],
): string {
	const allKeys = [...indexFields, ...coveringFields].join(", ");
	return `CREATE INDEX idx_covering ON \`${bucket}\`.\`${scope}\`.\`${collection}\`(${allKeys});`;
}

// SIO-1107: live analysis via the server-computed Index Advisor + EXPLAIN plan.
// Returns null when the cluster path yields nothing (both legs failed), so the
// caller can fall back to the offline regex heuristics. Exported for unit testing.
export async function runLiveOptimizationAnalysis(
	query: string,
	scopeName: string,
	bucket: Bucket,
	bucketName?: string,
): Promise<string | null> {
	const resolved = resolveBucket(bucket, bucketName);
	const scope = resolved.scope(scopeName);
	const { query: advisorStmt, parameters } = buildAdvisorQuery({ query });

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

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_suggest_query_optimizations",
		"Analyze a query and suggest optimizations and indexes. Uses the live Index Advisor and EXPLAIN plan when the cluster is reachable; falls back to offline heuristic analysis otherwise.",
		{
			query: z.string().describe("The N1QL query to analyze"),
			bucket_name: z.string().optional().describe("Bucket name (defaults to bucket in query)"),
			scope_name: z.string().optional().describe("Scope name (defaults to scope in query)"),
			collection_name: z.string().optional().describe("Collection name (defaults to collection in query)"),
		},
		async ({ query, bucket_name, scope_name, collection_name }) => {
			logger.info({ query, bucket_name, scope_name, collection_name }, "Analyzing query for optimizations");

			try {
				// Extract bucket, scope, collection if not provided
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
};

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
