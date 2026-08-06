/* src/tools/queryAnalysis/getPrimaryIndexQueries.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlPrimaryIndexes } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

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
			let query = n1qlPrimaryIndexes;

			// Apply limit if specified
			if (limit && limit > 0) {
				// Add or replace LIMIT clause
				if (query.includes("LIMIT")) {
					query = query.replace(/LIMIT \d+/i, `LIMIT ${limit}`);
				} else {
					query = `${query.replace(";", "")} LIMIT ${limit};`;
				}
			}

			return executeAnalysisQuery(bucket, query, "Queries Using Primary Indexes", limit);
		},
	);
};
