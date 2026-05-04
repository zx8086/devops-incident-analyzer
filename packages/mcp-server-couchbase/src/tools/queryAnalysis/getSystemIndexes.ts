// src/tools/queryAnalysis/getSystemIndexes.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { n1qlSystemIndexes } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type SystemIndexesInput = {
	bucket_name?: string;
	index_type?: string;
	include_system?: boolean;
};

export function buildQuery(input: SystemIndexesInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { bucket_name, index_type, include_system } = input;
	const whereClauses: string[] = [];
	const parameters: Record<string, unknown> = {};

	if (bucket_name) {
		whereClauses.push("t.keyspace_id = $bucket_name");
		parameters.bucket_name = bucket_name;
	}
	if (index_type) {
		whereClauses.push("t.using = $index_type");
		parameters.index_type = index_type;
	}
	if (include_system !== true) {
		whereClauses.push("t.`namespace` != 'system'");
	}

	const whereFragment = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
	const query = n1qlSystemIndexes.replace("/* WHERE_CLAUSES */", whereFragment);

	return { query, parameters };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_system_indexes",
		"Get information about all indexes in the system",
		{
			bucket_name: z.string().optional().describe("Filter by bucket name"),
			index_type: z.string().optional().describe("Filter by index type (e.g., GSI, FTS)"),
			include_system: z.boolean().optional().describe("Whether to include system indexes"),
		},
		async (input) => {
			logger.info(input, "Getting system indexes");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(bucket, query, "System Indexes", undefined, parameters);
		},
	);
};
