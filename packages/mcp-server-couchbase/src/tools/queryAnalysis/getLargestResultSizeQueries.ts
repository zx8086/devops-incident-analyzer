/* src/tools/queryAnalysis/getLargestResultSizeQueries.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlLargestResultSizeQueries } from "./analysisQueries";
import { applyAnalysisLimit, executeAnalysisQuery } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_largest_result_size_queries",
		{
			description: "Get queries that return the largest result sizes in bytes",
			inputSchema: {
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
				// SIO-1822: .finite() rejects NaN/Infinity, which would splice invalid SQL. A
				// fractional KB is meaningful here (the value is converted to bytes numerically),
				// so unlike the count filters this one is not restricted to integers.
				min_size_kb: z.number().finite().nonnegative().optional().describe("Minimum result size in KB to include"),
			},
			annotations: couchbaseToolAnnotations("capella_get_largest_result_size_queries"),
		},
		async ({ limit, min_size_kb }) => {
			logger.info({ limit, min_size_kb }, "Getting largest result size queries");

			// Modify query based on parameters
			let query = n1qlLargestResultSizeQueries;

			// Apply minimum size filter if specified
			if (min_size_kb && min_size_kb > 0) {
				// Convert KB to bytes for filtering
				const minSizeBytes = min_size_kb * 1000;

				query = query.replace(
					"LETTING avgResultSize = AVG(resultSize)",
					`LETTING avgResultSize = AVG(resultSize)
           HAVING avgResultSize >= ${minSizeBytes}`,
				);
			}

			const { query: limitedQuery, appliedLimit } = applyAnalysisLimit(query, limit);
			return executeAnalysisQuery(bucket, limitedQuery, "Queries with Largest Result Sizes", appliedLimit);
		},
	);
};
