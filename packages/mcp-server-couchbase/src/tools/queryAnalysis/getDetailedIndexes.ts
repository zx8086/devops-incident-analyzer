// src/tools/queryAnalysis/getDetailedIndexes.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { detailedIndexesQuery } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type DetailedIndexesInput = {
	bucket_name?: string;
	scope_name?: string;
	collection_name?: string;
	state?: string;
	has_condition?: boolean;
	is_primary?: boolean;
	index_type?: string;
	sort_by?: "name" | "state" | "keyspace_id" | "last_scan_time";
};

export function buildQuery(input: DetailedIndexesInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { bucket_name, scope_name, collection_name, state, has_condition, is_primary, index_type, sort_by } = input;
	const whereClauses: string[] = [];
	const parameters: Record<string, unknown> = {};

	if (bucket_name) {
		whereClauses.push("(t.bucket_id = $bucket_name OR t.keyspace_id = $bucket_name)");
		parameters.bucket_name = bucket_name;
	}
	if (scope_name) {
		whereClauses.push("t.scope_id = $scope_name");
		parameters.scope_name = scope_name;
	}
	if (collection_name) {
		whereClauses.push("t.keyspace_id = $collection_name");
		parameters.collection_name = collection_name;
	}
	if (state) {
		whereClauses.push("t.state = $state");
		parameters.state = state;
	}
	if (has_condition === true) {
		whereClauses.push("t.condition IS NOT NULL");
	} else if (has_condition === false) {
		whereClauses.push("t.condition IS NULL");
	}
	if (is_primary === true) {
		whereClauses.push("t.is_primary = true");
	} else if (is_primary === false) {
		whereClauses.push("(t.is_primary IS MISSING OR t.is_primary = false)");
	}
	if (index_type) {
		whereClauses.push("t.using = $index_type");
		parameters.index_type = index_type;
	}

	let orderByField: string;
	switch (sort_by) {
		case "name":
			orderByField = "t.name";
			break;
		case "state":
			orderByField = "t.state";
			break;
		case "last_scan_time":
			orderByField = "t.metadata.last_scan_time";
			break;
		default:
			orderByField = "t.keyspace_id, t.name";
			break;
	}

	const whereFragment = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
	const query = detailedIndexesQuery
		.replace("/* WHERE_CLAUSES */", whereFragment)
		.replace("/* ORDER_BY */", orderByField);

	return { query, parameters };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_detailed_indexes",
		"Get detailed information about all indexes in the Couchbase system",
		{
			bucket_name: z.string().optional().describe("Filter by bucket name"),
			scope_name: z.string().optional().describe("Filter by scope name"),
			collection_name: z.string().optional().describe("Filter by collection name"),
			state: z.string().optional().describe("Filter by state (e.g., 'online', 'deferred')"),
			has_condition: z.boolean().optional().describe("Filter for indexes with conditions"),
			is_primary: z.boolean().optional().describe("Filter for primary indexes only"),
			index_type: z.string().optional().describe("Filter by index type (e.g., 'GSI', 'FTS')"),
			sort_by: z
				.enum(["name", "state", "keyspace_id", "last_scan_time"])
				.optional()
				.default("keyspace_id")
				.describe("Sort results by field"),
		},
		async (input) => {
			logger.info(input, "Getting detailed indexes information");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(bucket, query, "Detailed Index Information", undefined, parameters);
		},
	);
};
