/* src/tools/queryAnalysis/getLongestRunningQueries.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
import { n1qlLongestRunningQueries } from "./analysisQueries";
import { applyAnalysisLimit, executeAnalysisQueryStructured } from "./queryAnalysisUtils";

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_longest_running_queries",
		{
			description:
				"Get the longest running queries based on service time. Returns bare JSON array of {statement, avgServiceTime, lastExecutionTime, queries} -- machine-readable for correlation extractors.",
			inputSchema: {
				limit: z.number().int().positive().optional().describe("Optional limit for the number of results to return"),
				// SIO-1822: .int() matters -- this value is spliced into the SQL, and a fractional
				// one silently disabled the filter (1.5 produced "1.5000000" ns via the old
				// string-append conversion, i.e. 1.5 ms, matching everything).
				min_time_ms: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe("Minimum average execution time in milliseconds to include (whole milliseconds)"),
			},
			annotations: couchbaseToolAnnotations("capella_get_longest_running_queries"),
		},
		async ({ limit, min_time_ms }) => {
			logger.info({ limit, min_time_ms }, "Getting longest running queries");

			let query = n1qlLongestRunningQueries;

			if (min_time_ms !== undefined && min_time_ms > 0) {
				// serviceTime is compared in nanoseconds. Compute the value numerically rather
				// than appending "000000" to its decimal text (SIO-1822).
				const minServiceTimeNs = min_time_ms * 1_000_000;
				query = query.replace(
					"LETTING avgServiceTime = AVG(STR_TO_DURATION(serviceTime))",
					`LETTING avgServiceTime = AVG(STR_TO_DURATION(serviceTime))
           HAVING avgServiceTime >= ${minServiceTimeNs}`,
				);
			}

			return executeAnalysisQueryStructured(bucket, applyAnalysisLimit(query, limit).query);
		},
	);
};
