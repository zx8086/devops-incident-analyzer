// src/tools/queryAnalysis/getNonCoveringIndexQueries.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { n1qlNonCoveringIndexQueries } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type NonCoveringIndexQueriesInput = {
	limit?: number;
};

export function buildQuery(input: NonCoveringIndexQueriesInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	let query = n1qlNonCoveringIndexQueries;
	// LIMIT is zod-validated as a positive integer before this splice (SIO-667
	// posture: values bind as $named params; LIMIT cannot be parameterized in N1QL).
	if (input.limit !== undefined && input.limit > 0) {
		query = `${query.trim().replace(/;$/, "")} LIMIT ${input.limit};`;
	}
	return { query, parameters: {} };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_non_covering_index_queries",
		"Get queries whose index scans still required a document fetch phase (the index did not cover the query). Empty results can mean request logging thresholds excluded fast queries.",
		{
			limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
		},
		async ({ limit }) => {
			logger.info({ limit }, "Getting non-covering index queries");
			const { query } = buildQuery({ limit });
			return executeAnalysisQuery(bucket, query, "Queries Not Using a Covering Index", limit);
		},
	);
};
