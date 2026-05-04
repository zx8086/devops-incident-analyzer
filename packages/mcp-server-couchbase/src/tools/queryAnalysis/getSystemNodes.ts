// src/tools/queryAnalysis/getSystemNodes.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { systemNodesQuery } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type SystemNodesInput = { service_filter?: string };

export function buildQuery(input: SystemNodesInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { service_filter } = input;
	if (!service_filter) {
		return { query: systemNodesQuery, parameters: {} };
	}

	const query = "SELECT * FROM system:nodes WHERE ANY s IN services SATISFIES s = $service_filter END;";
	return { query, parameters: { service_filter } };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_system_nodes",
		"Get information about all nodes in the Couchbase cluster",
		{
			service_filter: z.string().optional().describe("Filter by service type (e.g., 'n1ql', 'kv', 'index', 'fts')"),
		},
		async (input) => {
			logger.info(input, "Getting system nodes information");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(bucket, query, "Couchbase Cluster Nodes", undefined, parameters);
		},
	);
};
