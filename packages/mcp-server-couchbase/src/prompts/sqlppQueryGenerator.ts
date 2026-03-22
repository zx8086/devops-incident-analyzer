/* src/prompts/sqlppQueryGenerator.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../lib/logger";

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
			// Create fully qualified path with proper backticks
			const fullyQualifiedPath = `\`${bucket}\`.\`${scope || "_default"}\`.\`${collection}\``;

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

Collection path: ${fullyQualifiedPath}${filterText}${limitText}

Requirements:
1. Use fully qualified path with backticks for bucket, scope, and collection names
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
