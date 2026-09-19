/* src/tools/queryAnalysis/getPrimaryIndexQueries.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlPrimaryIndexes } from "./analysisQueries";
import { applyAnalysisLimit, executeAnalysisQuery } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_primary_index_queries",
		{
			description: "Get queries that used primary indexes, which can indicate inefficient querying",
			inputSchema: {
				limit: z.number().optional().describe("Optional limit for the number of results to return"),
			},
			annotations: couchbaseToolAnnotations("capella_get_primary_index_queries"),
		},
		async ({ limit }) => {
			logger.info({ limit }, "Getting primary index queries");

			// Modify query based on parameters
			const query = n1qlPrimaryIndexes;

			// SIO-1822: this query is a `SELECT *` over completed_requests rows that embed full
			// query plans, so the default limit matters most here -- unbounded, one call could
			// swamp the agent's context.
			const { query: limitedQuery, appliedLimit } = applyAnalysisLimit(query, limit);
			return executeAnalysisQuery(bucket, limitedQuery, "Queries Using Primary Indexes", appliedLimit);
		},
	);
};
