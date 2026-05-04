// src/tools/queryAnalysis/getMostExpensiveQueries.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { mostExpensiveQueries } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type MostExpensiveQueriesInput = {
	limit?: number;
	period?: "day" | "week" | "month";
};

// SIO-668: parity refactor only -- periodClause is built from a closed switch
// over a Zod enum, so no user input ever reaches the SQL string. No parameters
// needed. Extracted for grep-audit consistency with sibling tools.
export function buildQuery(input: MostExpensiveQueriesInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { limit, period } = input;
	let query = mostExpensiveQueries;

	if (period) {
		let periodClause: string;
		switch (period) {
			case "day":
				periodClause = "requestTime >= DATE_ADD_STR(NOW_STR(), -1, 'day')";
				break;
			case "week":
				periodClause = "requestTime >= DATE_ADD_STR(NOW_STR(), -1, 'week')";
				break;
			case "month":
				periodClause = "requestTime >= DATE_ADD_STR(NOW_STR(), -1, 'month')";
				break;
		}
		query = query.replace("WHERE LOWER(statement)", `WHERE ${periodClause} AND LOWER(statement)`);
	}

	if (limit && limit > 0) {
		if (/LIMIT \d+/i.test(query)) {
			query = query.replace(/LIMIT \d+/i, `LIMIT ${limit}`);
		} else {
			query = query.replace(/;\s*$/, ` LIMIT ${limit};`);
		}
	}

	return { query, parameters: {} };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_most_expensive_queries",
		"Get the most expensive queries based on execution time and resource usage",
		{
			limit: z.number().optional().describe("Optional limit for the number of results to return"),
			period: z.enum(["day", "week", "month"]).optional().describe("Optional period to analyze (day, week, month)"),
		},
		async (input) => {
			logger.info(input, "Getting most expensive queries");
			const { query, parameters } = buildQuery(input);
			logger.debug({ paramKeys: Object.keys(parameters) }, "Built most-expensive-queries query");
			return executeAnalysisQuery(bucket, query, "Most Expensive Queries", input.limit, parameters);
		},
	);
};
