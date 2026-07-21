// src/tools/explainSqlPlusPlusQuery.ts

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { config } from "../config";
import { adviseCouchbaseError } from "../lib/adviseCouchbaseError";
import { classifyCouchbaseError } from "../lib/classifyCouchbaseError";
import { evaluateQueryPlan, formatPlanFindings } from "../lib/queryPlan";
import { resolveBucket } from "../lib/resolveBucket";
import { sqlppParser } from "../lib/sqlppParser";
import { logger } from "../utils/logger";
import { adviseQuery } from "./queryAnalysis/getIndexAdvisor";

// Strip any leading EXPLAIN token (and trailing semicolon), then prepend exactly one.
export function buildExplainStatement(query: string): string {
	const trimmed = query.trim().replace(/;\s*$/, "");
	const inner = trimmed.replace(/^EXPLAIN\s+/i, "");
	return `EXPLAIN ${inner}`;
}

// Exported for unit testing.
export const explainQuery = async (
	params: { scope_name: string; query: string; bucket_name?: string },
	bucket: Bucket,
) => {
	const { scope_name, query, bucket_name } = params;

	// Same scope-context contract as capella_run_sql_plus_plus_query: bare
	// collection names only, no bucket.scope.collection paths.
	if (/from\s+[`\w]+\.[`\w]+\.[`\w]+/i.test(query)) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Error: Query uses full bucket.scope.collection path. When using scope context, only use the collection name in the query. For example: SELECT COUNT(*) FROM `_default`",
				},
			],
			isError: true,
		};
	}

	// EXPLAIN never executes the statement, but gating the INNER statement keeps
	// the read_only annotation honest and the posture uniform (stricter than the
	// official Python server, deliberately).
	const inner = query.trim().replace(/^EXPLAIN\s+/i, "");
	const parsed = sqlppParser.parse(inner);
	if (config.server.readOnlyQueryMode && (sqlppParser.modifiesData(parsed) || sqlppParser.modifiesStructure(parsed))) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Error: EXPLAIN of data/structure modification statements is not allowed in read-only mode",
				},
			],
			isError: true,
		};
	}

	const statement = buildExplainStatement(query);
	try {
		const resolved = resolveBucket(bucket, bucket_name);
		const result = await resolved.scope(scope_name).query(statement);
		const rows = await result.rows;
		const first = rows[0];
		// EXPLAIN returns one row, usually { plan, text }; fall back to the whole row on drift.
		const plan =
			first !== null && typeof first === "object" && "plan" in (first as Record<string, unknown>)
				? (first as Record<string, unknown>).plan
				: first;
		const findings = evaluateQueryPlan(plan);

		let text = "# Query Execution Plan\n\n";
		text += `## Statement\n\n\`\`\`sql\n${statement}\n\`\`\`\n\n`;
		text += `## Plan\n\n\`\`\`json\n${JSON.stringify(plan ?? null, null, 2)}\n\`\`\`\n\n`;
		text += `## Plan Analysis\n\n${formatPlanFindings(findings)}\n`;
		return { content: [{ type: "text" as const, text }] };
	} catch (error) {
		logger.error({ error, statement }, "Failed to explain query");
		const message = error instanceof Error ? error.message : String(error);
		const kind = classifyCouchbaseError(error);
		let advice = adviseCouchbaseError(kind);
		// Fold the advisor's real DDL into this same response instead of just telling the
		// agent to go call capella_get_index_advisor_recommendations itself -- one round
		// trip instead of two. Never let a secondary advisor failure mask the original
		// EXPLAIN error: swallow and fall back to the plain advice string.
		if (kind === "no-index") {
			try {
				// ADVISOR() cannot analyze a statement that still carries the EXPLAIN keyword --
				// it silently returns zero recommendations instead of erroring, so this must pass
				// the already-stripped inner statement (computed above for the read-only gate),
				// not the raw query param.
				const advisorResult = await adviseQuery({ scope_name, query: inner, bucket_name }, bucket);
				const advisorText = advisorResult.content[0]?.text;
				if (!advisorResult.isError && advisorText) {
					advice = `${advice ? `${advice} ` : ""}Index advisor recommendations:\n\n${advisorText}`;
				}
			} catch (advisorError) {
				logger.warn({ advisorError }, "Index advisor auto-enrichment failed; returning plain no-index advice");
			}
		}
		const envelope = buildToolErrorEnvelope({
			kind,
			message: `Failed to explain query: ${message}`,
			...(advice ? { advice } : {}),
		});
		return {
			content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
			isError: true,
		};
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_explain_sql_plus_plus_query",
		"Get the execution plan for a SQL++ query (EXPLAIN) plus an automated plan analysis: index usage, covering vs fetch, primary-scan warnings. Does not execute the query.",
		{
			scope_name: z.string().describe("Name of the scope to plan the query in"),
			query: z
				.string()
				.describe("SQL++ query to explain. Use only the collection name in the FROM clause (scope context)."),
			bucket_name: z.string().optional().describe("Optional bucket name (defaults to the configured bucket)"),
		},
		async (params) => {
			logger.info({ scope: params.scope_name, bucket: params.bucket_name }, "Explaining SQL++ query");
			return explainQuery(params, bucket);
		},
	);
};
