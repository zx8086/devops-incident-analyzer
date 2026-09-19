// src/tools/queryAnalysis/getNonCoveringIndexQueries.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlNonCoveringIndexQueries } from "./analysisQueries";
import { applyAnalysisLimit, executeAnalysisQuery } from "./queryAnalysisUtils";

export type NonCoveringIndexQueriesInput = {
	limit?: number;
};

export function buildQuery(input: NonCoveringIndexQueriesInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	// LIMIT is zod-validated as a positive integer before this splice (SIO-667 posture:
	// values bind as $named params; LIMIT cannot be parameterized in N1QL). SIO-1822: an
	// omitted limit now falls back to DEFAULT_ANALYSIS_LIMIT rather than returning every row.
	const { query } = applyAnalysisLimit(n1qlNonCoveringIndexQueries, input.limit);
	return { query, parameters: {} };
}

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_non_covering_index_queries",
		{
			description:
				"Get queries whose index scans still required a document fetch phase (the index did not cover the query). Empty results can mean request logging thresholds excluded fast queries.",
			inputSchema: {
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
			},
			annotations: couchbaseToolAnnotations("capella_get_non_covering_index_queries"),
		},
		async ({ limit }) => {
			logger.info({ limit }, "Getting non-covering index queries");
			const { query } = buildQuery({ limit });
			return executeAnalysisQuery(bucket, query, "Queries Not Using a Covering Index", limit);
		},
	);
};
