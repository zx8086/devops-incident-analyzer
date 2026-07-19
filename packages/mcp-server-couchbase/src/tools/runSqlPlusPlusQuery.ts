/* src/tools/runSqlPlusPlusQuery.ts */

// IMPORTANT: When using the SDK's scope context, queries must only reference the collection name in the FROM clause.
// Example: SELECT COUNT(*) FROM `_default` (NOT FROM `bucket`.`scope`.`collection`)

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { adviseCouchbaseError } from "../lib/adviseCouchbaseError";
import { classifyCouchbaseError } from "../lib/classifyCouchbaseError";
import { AppError } from "../lib/errors";
import { runSqlPlusPlusQuery } from "../lib/runSqlPlusPlusQuery";
import { sqlppParser } from "../lib/sqlppParser";
import { logger } from "../utils/logger";

// Ensure all queries use only the collection name in the FROM clause when using scope context
// Exported for unit testing (SIO-744).
export const runQuery = async (params: { scope_name: string; query: string }, bucket: Bucket) => {
	if (!bucket) {
		return {
			content: [{ type: "text" as const, text: "Database error: bucket not found" }],
			isError: true,
		};
	}

	const { scope_name, query } = params;

	// Throw an error if the query uses a full bucket.scope.collection path (contains two dots in FROM clause)
	if (/from\s+[`\w]+\.[`\w]+\.[`\w]+/i.test(query)) {
		logger.error(
			{ query },
			"Query uses full bucket.scope.collection path. When using scope context, only use the collection name in the query.",
		);
		// SIO-1162: emit the structured bad-query envelope (previously a plain { text } error,
		// which the agent read as category "unknown" = degrading even though this is a trivially
		// fixable query mistake). bad-query is degrading but ACTIONABLE, and the advice tells the
		// agent exactly how to correct it -- so it stops re-issuing the same broken path.
		const envelope = buildToolErrorEnvelope({
			kind: "bad-query",
			message:
				"Query uses a full bucket.scope.collection path in the FROM clause. Under scope context, reference only the collection name.",
			advice:
				"Drop the bucket.scope prefix from the FROM clause and pass the scope via the scope_name argument. " +
				'Example: scope_name="inventory", query="SELECT COUNT(*) FROM `airline`" (NOT FROM `bucket`.`inventory`.`airline`).',
		});
		return {
			content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
			isError: true,
		};
	}

	try {
		const result = await runSqlPlusPlusQuery({ lifespanContext: { bucket } }, scope_name, query, sqlppParser);
		const rows = result.rows as Record<string, unknown>[];

		if (rows.length === 1 && rows[0] !== undefined && "distinct_source_count" in rows[0]) {
			return {
				content: [{ type: "text" as const, text: `Found ${rows[0].distinct_source_count} distinct sources` }],
				_meta: { rowCount: 1 },
				isError: false,
			};
		}

		return {
			content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
			_meta: { rowCount: rows.length, meta: result.meta },
			isError: false,
		};
	} catch (error) {
		logger.error({ error }, "Failed to execute query");
		// SIO-744/SIO-1078: surface the underlying N1QL error so the LLM can recover (e.g.
		// fix a syntax issue or drop an unindexed predicate) instead of looping. The lib
		// layer wraps the real error via createError("QUERY_ERROR", "Failed to execute
		// query", originalError), so AppError.message is the generic prefix and the actual
		// N1QL detail lives on AppError.originalError -- prefer that cause. Falling back to
		// error.message alone produced the doubled "Failed to execute query: Failed to
		// execute query" that told the LLM nothing.
		const cause = error instanceof AppError ? error.originalError : undefined;
		const message = cause?.message ?? (error instanceof Error ? error.message : String(error));
		// SIO-1087: classify on the SDK error CLASS + N1QL first_error_code (not the message
		// string) and emit the shared { _error: { kind, category } } envelope. A "no index
		// available" planning failure becomes kind "no-index" (category no-data) so the agent
		// treats it as a routine discovery outcome that does NOT cap confidence, rather than a
		// generic "unknown" tool malfunction. The human text still carries the N1QL detail.
		const kind = classifyCouchbaseError(error);
		// SIO-1162: attach copy-paste remediation so a no-index becomes a "filter on the
		// leading key" steer and a parse failure a "fix the FROM clause" steer, instead of a
		// silent re-issue loop. The agent reads _error.advice structurally.
		const advice = adviseCouchbaseError(kind);
		const envelope = buildToolErrorEnvelope({
			kind,
			message: `Failed to execute query: ${message}`,
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
		"capella_run_sql_plus_plus_query",
		"Execute a SQL++ query against a specific scope in the Couchbase bucket",
		{
			scope_name: z.string().describe("Name of the scope"),
			query: z
				.string()
				.describe("SQL++ query to execute. Use only the collection name in the FROM clause if using scope context."),
		},
		async (params, _extra) => {
			return runQuery(params, bucket);
		},
	);
};
