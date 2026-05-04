// src/tools/queryAnalysis/getSystemVitals.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { systemVitalsQuery } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type SystemVitalsInput = { node_filter?: string };

// SIO-667: build the LIKE pattern in JS and bind the whole pattern as a literal.
// Wildcard semantics for `%`/`_` inside the user value are preserved (matches
// pre-fix behavior); the change closes the SQL injection vector by preventing
// the value from escaping the string-literal context.
export function buildQuery(input: SystemVitalsInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { node_filter } = input;
	if (!node_filter) {
		return { query: systemVitalsQuery, parameters: {} };
	}

	const query = "SELECT * FROM system:vitals WHERE node LIKE $node_pattern;";
	return { query, parameters: { node_pattern: `%${node_filter}%` } };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_system_vitals",
		"Get detailed system vitals and performance metrics for the Couchbase cluster",
		{
			node_filter: z.string().optional().describe("Filter by node name (e.g., 'node1.example.com:8091')"),
		},
		async (input) => {
			logger.info(input, "Getting system vitals information");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(bucket, query, "Couchbase System Vitals", undefined, parameters);
		},
	);
};
