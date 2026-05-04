// src/tools/queryAnalysis/getDetailedPreparedStatements.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { detailedPreparedStatementsQuery } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type DetailedPreparedStatementsInput = {
	limit?: number;
	node_filter?: string;
	query_pattern?: string;
};

// SIO-668: bind LIKE patterns as named literals; mirrors getSystemVitals from
// SIO-667. User `%`/`_` inside the pattern still expand as LIKE wildcards
// (acceptable -- threat model is SQL injection, not over-broad matching).
export function buildQuery(input: DetailedPreparedStatementsInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { limit, node_filter, query_pattern } = input;
	const whereClauses: string[] = [];
	const parameters: Record<string, unknown> = {};

	if (node_filter) {
		whereClauses.push("node LIKE $node_pattern");
		parameters.node_pattern = `%${node_filter}%`;
	}
	if (query_pattern) {
		whereClauses.push("statement LIKE $query_pattern_like");
		parameters.query_pattern_like = `%${query_pattern}%`;
	}

	let query = detailedPreparedStatementsQuery;

	// Base SQL has no WHERE -- ORDER BY branch is the only path that ever runs.
	// (Pre-SIO-668 the file also had a dead query.includes("WHERE") branch.)
	if (whereClauses.length > 0) {
		const whereFragment = `WHERE ${whereClauses.join(" AND ")}`;
		if (query.includes("ORDER BY")) {
			query = query.replace(/ORDER BY/i, `${whereFragment} ORDER BY`);
		} else {
			query = query.replace(";", ` ${whereFragment};`);
		}
	}

	if (limit && limit > 0) {
		if (query.includes("LIMIT")) {
			query = query.replace(/LIMIT \d+/i, `LIMIT ${limit}`);
		} else {
			query = query.replace(";", ` LIMIT ${limit};`);
		}
	}

	return { query, parameters };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_detailed_prepared_statements",
		"Get detailed information about prepared statements with usage statistics",
		{
			limit: z.number().optional().describe("Optional limit for the number of results to return"),
			node_filter: z.string().optional().describe("Filter by node name (e.g., 'node1.example.com:8091')"),
			query_pattern: z.string().optional().describe("Filter by query pattern (e.g., 'SELECT')"),
		},
		async (input) => {
			logger.info(input, "Getting detailed prepared statements");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(bucket, query, "Prepared Statements Analysis", input.limit, parameters);
		},
	);
};
