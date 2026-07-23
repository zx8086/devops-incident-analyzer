/* src/tools/queryAnalysis/getFatalRequests.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { DEFAULT_ANALYSIS_LIMIT, n1qlQueryFatalRequests } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type FatalRequestsInput = {
	period?: "day" | "week" | "month" | "quarter";
	limit?: number;
};

export function buildQuery(input: FatalRequestsInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { period, limit } = input;
	let query = n1qlQueryFatalRequests;

	if (period) {
		// Closed switch over a Zod enum -- replacement string never includes user input.
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
		query = query.replace(
			/DATE_ADD_STR\(NOW_STR\(\), -\d+, '\w+'\)/,
			`DATE_ADD_STR(NOW_STR(), -${periodValue}, '${periodUnit}')`,
		);
	}

	// Always bound the result set: without a LIMIT the trailing ORDER BY sorted the
	// full 8-week fatal-request window on every call (~3.7s). The LIMIT goes after
	// the UNION ALL, so it caps the combined row set.
	const effectiveLimit = limit && limit > 0 ? limit : DEFAULT_ANALYSIS_LIMIT;
	query = query.replace("ORDER BY requestTime DESC;", `ORDER BY requestTime DESC LIMIT ${effectiveLimit};`);

	return { query, parameters: {} };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_fatal_requests",
		"Get information about failed/fatal N1QL queries",
		{
			period: z
				.enum(["day", "week", "month", "quarter"])
				.optional()
				.describe("Time period to analyze (day, week, month, quarter)"),
			limit: z.number().optional().describe("Optional limit for the number of results to return"),
		},
		async ({ period, limit }) => {
			logger.info({ period, limit }, "Getting fatal query requests");
			const { query } = buildQuery({ period, limit });
			return executeAnalysisQuery(bucket, query, "Fatal Query Requests", limit);
		},
	);
};
