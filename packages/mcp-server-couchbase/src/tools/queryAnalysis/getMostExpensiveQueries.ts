// src/tools/queryAnalysis/getMostExpensiveQueries.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { DEFAULT_ANALYSIS_LIMIT, mostExpensiveQueries } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type MostExpensiveQueriesInput = {
	limit?: number;
	period?: "day" | "week" | "month";
};

// SIO-668: the substitutions are built from a closed switch over a Zod enum, so
// no user input ever reaches the SQL string. No parameters needed.
// SIO-1175: the base query carries a default 8-week window; period REWRITES that
// window (mirrors getCompletedRequests) instead of adding a second predicate,
// and a LIMIT is always applied so the GROUP BY + ORDER BY stays bounded.
export function buildQuery(input: MostExpensiveQueriesInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { limit, period } = input;
	let query = mostExpensiveQueries;

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
		query = query.replace(/DATE_ADD_STR\(NOW_STR\(\), -\d+, '\w+'\)/, `DATE_ADD_STR(NOW_STR(), -1, '${periodUnit}')`);
	}

	const effectiveLimit = limit && limit > 0 ? limit : DEFAULT_ANALYSIS_LIMIT;
	if (/LIMIT \d+/i.test(query)) {
		query = query.replace(/LIMIT \d+/i, `LIMIT ${effectiveLimit}`);
	} else {
		query = query.replace(/;\s*$/, ` LIMIT ${effectiveLimit};`);
	}

	return { query, parameters: {} };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_most_expensive_queries",
		"Get the most expensive queries based on execution time and resource usage (defaults: last 8 weeks, limit 50)",
		{
			limit: z.number().optional().describe("Optional limit for the number of results to return (default 50)"),
			period: z
				.enum(["day", "week", "month"])
				.optional()
				.describe("Optional period to analyze (day, week, month); defaults to the last 8 weeks"),
		},
		async (input) => {
			logger.info(input, "Getting most expensive queries");
			const { query, parameters } = buildQuery(input);
			logger.debug({ paramKeys: Object.keys(parameters) }, "Built most-expensive-queries query");
			return executeAnalysisQuery(bucket, query, "Most Expensive Queries", input.limit, parameters);
		},
	);
};
