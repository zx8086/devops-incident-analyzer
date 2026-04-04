/* src/tools/queryAnalysis/getSystemVitals.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { systemVitalsQuery } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_system_vitals",
		"Get detailed system vitals and performance metrics for the Couchbase cluster",
		{
			node_filter: z.string().optional().describe("Filter by node name (e.g., 'node1.example.com:8091')"),
		},
		async ({ node_filter }) => {
			logger.info({ node_filter }, "Getting system vitals information");

			// Modify query based on parameters
			let query = systemVitalsQuery;

			// Apply node filter if specified
			if (node_filter) {
				query = query.replace(
					"SELECT * FROM system:vitals;",
					`SELECT * FROM system:vitals 
           WHERE node LIKE "%${node_filter}%";`,
				);
			}

			return executeAnalysisQuery(bucket, query, "Couchbase System Vitals");
		},
	);
};
