// src/tools/queryAnalysis/getIndexesToDrop.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { n1qlIndexesToDrop } from "./analysisQueries";
import { executeAnalysisQuery } from "./queryAnalysisUtils";

export type IndexesToDropInput = { bucket_filter?: string };

export function buildQuery(input: IndexesToDropInput): {
	query: string;
	parameters: Record<string, unknown>;
} {
	const { bucket_filter } = input;
	if (!bucket_filter) {
		return { query: n1qlIndexesToDrop, parameters: {} };
	}

	const buckets = bucket_filter
		.split(",")
		.map((b) => b.trim())
		.filter(Boolean);

	if (buckets.length === 0) {
		return { query: n1qlIndexesToDrop, parameters: {} };
	}

	const placeholders = buckets.map((_, i) => `$b${i}`);
	const parameters: Record<string, unknown> = {};
	for (const [i, value] of buckets.entries()) {
		parameters[`b${i}`] = value;
	}

	// Both `ANY v IN [...]` literals (inner sub-SELECT and outer WHERE) get the
	// same placeholder list -- they need to filter by the same bucket set.
	const query = n1qlIndexesToDrop.replace(/ANY v IN \[.*?\]/g, `ANY v IN [${placeholders.join(", ")}]`);

	return { query, parameters };
}

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_indexes_to_drop",
		"Get indexes that might be candidates for removal (never scanned)",
		{
			bucket_filter: z.string().optional().describe("Optional filter for bucket names (comma-separated)"),
		},
		async (input) => {
			logger.info(input, "Getting indexes that are candidates for removal");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(
				bucket,
				query,
				"Indexes That Could Be Dropped (Never Scanned)",
				undefined,
				parameters,
			);
		},
	);
};
