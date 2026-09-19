// src/tools/queryAnalysis/getSystemIndexes.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { couchbaseToolAnnotations } from "../tool-classification";
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
		// SIO-1822: system:indexes names the bucket differently per index scope. A
		// collection-level index carries bucket_id=<bucket> with keyspace_id=<collection>;
		// only a legacy bucket-level index has keyspace_id=<bucket>. Matching keyspace_id
		// alone therefore hid every collection-level index: measured live, this filter
		// returned 6 of 99 rows (93 of which had bucket_id set). Same predicate as the
		// sibling getDetailedIndexes.ts.
		whereClauses.push("(t.bucket_id = $bucket_name OR t.keyspace_id = $bucket_name)");
		parameters.bucket_name = bucket_name;
	}
	if (index_type) {
		// `using` is a SQL++ reserved word -- unescaped it fails to parse. The catalog
		// stores lowercase ("gsi") while callers pass "GSI"; compare case-insensitively.
		whereClauses.push("LOWER(t.`using`) = LOWER($index_type)");
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
	server.registerTool(
		"capella_get_system_indexes",
		{
			description: "Get information about all indexes in the system",
			inputSchema: {
				bucket_name: z.string().optional().describe("Filter by bucket name"),
				index_type: z.string().optional().describe("Filter by index type (e.g., GSI, FTS)"),
				include_system: z.boolean().optional().describe("Whether to include system indexes"),
			},
			annotations: couchbaseToolAnnotations("capella_get_system_indexes"),
		},
		async (input) => {
			logger.info(input, "Getting system indexes");
			const { query, parameters } = buildQuery(input);
			return executeAnalysisQuery(bucket, query, "System Indexes", undefined, parameters);
		},
	);
};
