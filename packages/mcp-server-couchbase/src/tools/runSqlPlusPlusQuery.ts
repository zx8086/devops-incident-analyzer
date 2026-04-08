/* src/tools/runSqlPlusPlusQuery.ts */

// IMPORTANT: When using the SDK's scope context, queries must only reference the collection name in the FROM clause.
// Example: SELECT COUNT(*) FROM `_default` (NOT FROM `bucket`.`scope`.`collection`)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { runSqlPlusPlusQuery } from "../lib/runSqlPlusPlusQuery";
import { sqlppParser } from "../lib/sqlppParser";
import { logger } from "../utils/logger";

// Ensure all queries use only the collection name in the FROM clause when using scope context
const runQuery = async (params: { scope_name: string; query: string }, bucket: Bucket) => {
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

	try {
		const result = await runSqlPlusPlusQuery({ lifespanContext: { bucket } }, scope_name, query, sqlppParser);
		const rows = result.rows as Record<string, unknown>[];

		if (rows.length === 1 && "distinct_source_count" in rows[0]) {
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
		return {
			content: [{ type: "text" as const, text: "Failed to execute query" }],
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
