// src/tools/queryAnalysis/getCompletedRequests.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { COMPLETED_REQUESTS_DEFAULT_LIMIT, completedRequestsQuery } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type CompletedRequestsInput = {
	limit?: number;
	period?: "day" | "week" | "month" | "quarter";
	status?: "success" | "fatal" | "timeout" | "all";
	includePlan?: boolean;
};

// SIO-1774: the filter used to bind the enum value straight into `state = $status`, but
// system:completed_requests has no "success" state (live: completed 7995, fatal 3, closed 1,
// stopped 1), so `status: "success"` matched nothing and read as "no successful traffic".
const COMPLETED_REQUEST_STATES: Record<"success" | "fatal" | "timeout", string> = {
	success: "completed",
	fatal: "fatal",
	timeout: "timeout",
};

// Shared with the v2 registration so the two cannot drift.
export const COMPLETED_REQUESTS_DESCRIPTION =
	"Slowest completed query requests first (ordered by elapsed time), with timings, phase counts, errors and Couchbase's own analysis hints";
export const COMPLETED_REQUESTS_LIMIT_DESCRIPTION = `Rows to return (default ${COMPLETED_REQUESTS_DEFAULT_LIMIT}, slowest first)`;
export const COMPLETED_REQUESTS_PLAN_DESCRIPTION =
	"Include each request's full execution plan. Large (several KB per row): ask for it only with a small limit, when you need to see why ONE query is slow";

export function buildQuery(input: CompletedRequestsInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { limit, period, status, includePlan } = input;
	const parameters: Record<string, unknown> = {};
	let query = completedRequestsQuery(includePlan === true);

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
		parameters.status = COMPLETED_REQUEST_STATES[status];
	}

	// Always bound the result set: an unbounded query materialized and sorted the
	// whole 8-week completed_requests window (~3.7s per call).
	const effectiveLimit = limit && Number.isInteger(limit) && limit > 0 ? limit : COMPLETED_REQUESTS_DEFAULT_LIMIT;
	if (query.includes("LIMIT")) {
		query = query.replace(/LIMIT \d+/i, `LIMIT ${effectiveLimit}`);
	} else {
		query = `${query.replace(";", "")} LIMIT ${effectiveLimit};`;
	}

	return { query, parameters };
}

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_completed_requests",
		{
			description: COMPLETED_REQUESTS_DESCRIPTION,
			inputSchema: {
				limit: z.number().int().positive().optional().describe(COMPLETED_REQUESTS_LIMIT_DESCRIPTION),
				period: z
					.enum(["day", "week", "month", "quarter"])
					.optional()
					.describe("Time period to analyze (day, week, month, quarter)"),
				status: z.enum(["success", "fatal", "timeout", "all"]).optional().describe("Filter by request status"),
				includePlan: z.boolean().optional().describe(COMPLETED_REQUESTS_PLAN_DESCRIPTION),
			},
			annotations: couchbaseToolAnnotations("capella_get_completed_requests"),
		},
		async (input) => {
			logger.info(input, "Getting completed requests");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(bucket, query, "Completed Query Requests", input.limit, parameters);
		},
	);
};
