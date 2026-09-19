// src/tools/queryAnalysis/getLowSelectivityQueries.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlLowSelectivityQueries } from "./analysisQueries";
import { applyAnalysisLimit, executeAnalysisQuery } from "./queryAnalysisUtils";

export type LowSelectivityQueriesInput = {
	limit?: number;
};

export function buildQuery(input: LowSelectivityQueriesInput): {
	query: string;
	parameters: Record<string, unknown>;
	appliedLimit: number;
} {
	// LIMIT is zod-validated as a positive integer before this splice (SIO-667 posture:
	// values bind as $named params; LIMIT cannot be parameterized in N1QL). SIO-1822: an
	// omitted limit now falls back to DEFAULT_ANALYSIS_LIMIT rather than returning every row.
	//
	// appliedLimit is returned so the caller can report it (review): passing the raw `limit`
	// on to executeAnalysisQuery leaves it undefined when omitted, which suppresses the
	// "Limit Application" section -- so a result capped at 50 would read as complete.
	const { query, appliedLimit } = applyAnalysisLimit(n1qlLowSelectivityQueries, input.limit);
	return { query, parameters: {}, appliedLimit };
}

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_low_selectivity_queries",
		{
			description:
				"Get queries whose index scans read far more entries than they returned (poor selectivity; the index or predicate filters too little). Empty results can mean request logging thresholds excluded fast queries.",
			inputSchema: {
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
			},
			annotations: couchbaseToolAnnotations("capella_get_low_selectivity_queries"),
		},
		async ({ limit }) => {
			logger.info({ limit }, "Getting low selectivity queries");
			const { query, appliedLimit } = buildQuery({ limit });
			return executeAnalysisQuery(bucket, query, "Queries With Low Index Selectivity", appliedLimit);
		},
	);
};
