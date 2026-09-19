/* src/tools/queryAnalysis/getLargestResultCountQueries.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlLargestResultCountQueries } from "./analysisQueries";
import { applyAnalysisLimit, executeAnalysisQuery } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_largest_result_count_queries",
		{
			description: "Get queries that return the largest number of results",
			inputSchema: {
				limit: z.number().optional().describe("Optional limit for the number of results to return"),
				// SIO-1822: spliced into the SQL; rejects NaN/Infinity and fractional counts.
				min_count: z.number().int().nonnegative().optional().describe("Minimum average result count to include"),
			},
			annotations: couchbaseToolAnnotations("capella_get_largest_result_count_queries"),
		},
		async ({ limit, min_count }) => {
			logger.info({ limit, min_count }, "Getting largest result count queries");

			// Modify query based on parameters
			let query = n1qlLargestResultCountQueries;

			// Apply minimum count filter if specified
			if (min_count && min_count > 0) {
				query = query.replace(
					"LETTING avgResultCount = AVG(resultCount)",
					`LETTING avgResultCount = AVG(resultCount)
           HAVING avgResultCount >= ${min_count}`,
				);
			}

			const { query: limitedQuery, appliedLimit } = applyAnalysisLimit(query, limit);
			return executeAnalysisQuery(bucket, limitedQuery, "Queries with Largest Result Counts", appliedLimit);
		},
	);
};
