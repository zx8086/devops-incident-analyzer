/* src/tools/queryAnalysis/getMostFrequentQueries.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlMostFrequentQueries } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_most_frequent_queries",
		{
			description: "Get the most frequently executed queries",
			inputSchema: {
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
				min_count: z.number().optional().describe("Minimum execution count to include"),
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

			// Apply limit if specified
			if (limit && Number.isInteger(limit) && limit > 0) {
				// Add or replace LIMIT clause
				if (query.includes("LIMIT")) {
					query = query.replace(/LIMIT \d+/i, `LIMIT ${limit}`);
				} else {
					query = `${query.replace(";", "")} LIMIT ${limit};`;
				}
			}

			return executeAnalysisQuery(bucket, query, "Most Frequently Executed Queries", limit);
		},
	);
};
