/* src/tools/queryAnalysis/getMostFrequentQueries.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlMostFrequentQueries } from "./analysisQueries";
import { applyAnalysisLimit, executeAnalysisQuery } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_most_frequent_queries",
		{
			description: "Get the most frequently executed queries",
			inputSchema: {
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
				// SIO-1822: .int() -- this is spliced into the SQL, and an execution count is a
				// whole number. Also rejects NaN/Infinity, which would emit invalid SQL.
				min_count: z.number().int().nonnegative().optional().describe("Minimum execution count to include"),
			},
			annotations: couchbaseToolAnnotations("capella_get_most_frequent_queries"),
		},
		async ({ limit, min_count }) => {
			logger.info({ limit, min_count }, "Getting most frequent queries");

			// Modify query based on parameters
			let query = n1qlMostFrequentQueries;

			// Apply minimum count filter if specified
			if (min_count && min_count > 0) {
				query = query.replace(
					"LETTING queries = COUNT(1)",
					`LETTING queries = COUNT(1)
           HAVING queries >= ${min_count}`,
				);
			}

			const { query: limitedQuery, appliedLimit } = applyAnalysisLimit(query, limit);
			return executeAnalysisQuery(bucket, limitedQuery, "Most Frequently Executed Queries", appliedLimit);
		},
	);
};
