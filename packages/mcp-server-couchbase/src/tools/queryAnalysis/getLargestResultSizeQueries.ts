/* src/tools/queryAnalysis/getLargestResultSizeQueries.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlLargestResultSizeQueries } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_largest_result_size_queries",
		{
			description: "Get queries that return the largest result sizes in bytes",
			inputSchema: {
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
				min_size_kb: z.number().optional().describe("Minimum result size in KB to include"),
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

			// Apply limit if specified
			if (limit && Number.isInteger(limit) && limit > 0) {
				// Add or replace LIMIT clause
				if (query.includes("LIMIT")) {
					query = query.replace(/LIMIT \d+/i, `LIMIT ${limit}`);
				} else {
					query = `${query.replace(";", "")} LIMIT ${limit};`;
				}
			}

			return executeAnalysisQuery(bucket, query, "Queries with Largest Result Sizes", limit);
		},
	);
};
