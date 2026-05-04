// src/tools/queryAnalysis/getCompletedRequests.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { n1qlCompletedRequests } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type CompletedRequestsInput = {
	limit?: number;
	period?: "day" | "week" | "month" | "quarter";
	status?: "success" | "fatal" | "timeout" | "all";
};

export function buildQuery(input: CompletedRequestsInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { limit, period, status } = input;
	const parameters: Record<string, unknown> = {};
	let query = n1qlCompletedRequests;

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

	// SIO-668: bind $status for consistency with sibling tools, even though
	// Zod restricts to a closed enum. "all" still skips the filter entirely
	// (pre-SIO-668 behavior preserved).
	if (status && status !== "all") {
		if (query.includes("WHERE")) {
			query = query.replace(/WHERE/, "WHERE state = $status AND");
		} else {
			query = query.replace(/ORDER BY/, "WHERE state = $status ORDER BY");
		}
		parameters.status = status;
	}

	if (limit && limit > 0) {
		if (query.includes("LIMIT")) {
			query = query.replace(/LIMIT \d+/i, `LIMIT ${limit}`);
		} else {
			query = `${query.replace(";", "")} LIMIT ${limit};`;
		}
	}

	return { query, parameters };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_completed_requests",
		"Get recent completed query requests with detailed execution information",
		{
			limit: z.number().optional().describe("Optional limit for the number of results to return"),
			period: z
				.enum(["day", "week", "month", "quarter"])
				.optional()
				.describe("Time period to analyze (day, week, month, quarter)"),
			status: z.enum(["success", "fatal", "timeout", "all"]).optional().describe("Filter by request status"),
		},
		async (input) => {
			logger.info(input, "Getting completed requests");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(bucket, query, "Completed Query Requests", input.limit, parameters);
		},
	);
};
