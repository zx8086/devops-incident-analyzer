/* src/prompts/sqlppQueryGenerator.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../utils/logger";

export function registerSqlppQueryGenerator(server: McpServer): void {
	server.prompt(
		"generate_sqlpp_query",
		{
			description: z.string().describe("What you want to accomplish with this query"),
			bucket: z.string().describe("The bucket name (e.g., 'travel-sample')"),
			scope: z
				.string()
				.optional()
				.describe("The scope name (e.g., 'inventory'). If not provided, '_default' will be used"),
			collection: z.string().describe("The collection name (e.g., 'hotel')"),
			filters: z.string().optional().describe("Any conditions for filtering results"),
			limit: z.string().optional().describe("Maximum number of results to return"),
		},
		(args) => {
			const { description, bucket, scope, collection, filters, limit } = args;
			// SIO-1078: capella_run_sql_plus_plus_query executes under SDK scope context
			// (bucket.scope(scope_name).query(...)), so the FROM clause must reference ONLY
			// the collection name. A fully-qualified `bucket`.`scope`.`collection` path is
			// rejected by the tool guard. Surface bucket/scope/collection separately and steer
			// the scope to the tool's scope_name argument, never into the FROM clause.
			const scopeName = scope || "_default";
			const collectionRef = `\`${collection}\``;

			// Build description of what to filter by
			const filterText = filters ? `\nFilter criteria: ${filters}` : "";

			// Add limit if provided
			const limitText = limit ? `\nLimit results to: ${limit} items` : "";

			return {
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: `Please write an optimized SQL++ query for Couchbase that will ${description}.

Bucket: \`${bucket}\` | Scope (pass as the tool's scope_name argument): \`${scopeName}\` | Collection: ${collectionRef}${filterText}${limitText}

Requirements:
1. Reference ONLY the collection name in the FROM clause (e.g. SELECT * FROM ${collectionRef}). The query runs inside scope context, so the scope is supplied separately via the scope_name argument. Do NOT write a fully-qualified \`bucket\`.\`scope\`.\`collection\` path -- such paths are rejected.
2. Include appropriate WHERE clauses based on the filter criteria
3. Make the query readable with proper formatting
4. Apply any limit specified, or use a reasonable default limit if none specified
5. Use SQL++ syntax (not N1QL) and follow Couchbase best practices
6. Provide a brief explanation of how the query works`,
						},
					},
				],
			};
		},
	);

	logger.info("SQL++ query generator prompt registered successfully");
}
