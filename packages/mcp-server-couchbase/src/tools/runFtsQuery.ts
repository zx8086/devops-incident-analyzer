// src/tools/runFtsQuery.ts

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket, SearchQueryOptions } from "couchbase";
import { SearchQuery, SearchRequest } from "couchbase";
import { z } from "zod";
import { classifyCouchbaseError, summarizeCouchbaseError } from "../lib/classifyCouchbaseError";
import { assertScopeArgs } from "../lib/ftsIndexes";
import { resolveBucket } from "../lib/resolveBucket";
import { logger } from "../utils/logger";
import { couchbaseToolAnnotations } from "./tool-classification";

export const MAX_FTS_LIMIT = 100;
export const DEFAULT_FTS_LIMIT = 10;

// Exported for unit testing. A search index can be enormous -- one on the live cluster
// reports 692,316 total rows -- so the row cap is the difference between a usable answer
// and a flooded context. The clamp is here rather than only in the Zod schema because
// `explain` overrides it (see below) and both rules belong in one place.
export function resolveFtsLimit(limit: number | undefined, explain: boolean): number {
	// An explanation is per matched hit, not a separate document: the Search service
	// returns it attached to each row. One row is enough to read the plan, and asking for
	// more multiplies a already-verbose payload. Upstream does the same.
	if (explain) return 1;
	if (limit === undefined) return DEFAULT_FTS_LIMIT;
	return Math.min(Math.max(limit, 1), MAX_FTS_LIMIT);
}

export const runFtsQuery = async (
	params: {
		index_name: string;
		query: Record<string, unknown>;
		limit?: number;
		fields?: string[];
		explain?: boolean;
		bucket_name?: string;
		scope_name?: string;
	},
	bucket: Bucket,
) => {
	const { index_name, query, limit, fields, explain, bucket_name, scope_name } = params;

	const argError = assertScopeArgs(bucket_name, scope_name);
	if (argError) {
		const envelope = buildToolErrorEnvelope({ kind: "bad-input", message: argError });
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}

	const appliedLimit = resolveFtsLimit(limit, explain === true);
	const options: SearchQueryOptions = {
		limit: appliedLimit,
		...(fields ? { fields } : {}),
		...(explain ? { explain: true } : {}),
	};

	try {
		const request = SearchRequest.create(new SearchQuery(query));
		// Scoped indexes answer to their bare name via scope.search(); the cluster needs the
		// dotted form. Verified live: cluster.search("stylesIndex08052025") throws
		// IndexNotFoundError while scope("styles").search of the same name succeeds.
		const result = scope_name
			? await resolveBucket(bucket, bucket_name).scope(scope_name).search(index_name, request, options)
			: await bucket.cluster.search(index_name, request, options);

		// The row shape is { index, id, score, locations, fragments, fields?, explanation? }.
		// metrics.total_rows is the match count BEFORE the limit, so the agent can tell
		// "3 matches" from "3 of 692,316 shown" -- surface it rather than only the rows.
		const metrics = (result.meta as { metrics?: Record<string, unknown> } | undefined)?.metrics;
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({ rows: result.rows, metrics, appliedLimit }, null, 2),
				},
			],
			_meta: { rowCount: result.rows.length, appliedLimit },
			isError: false,
		};
	} catch (error) {
		logger.error({ error: summarizeCouchbaseError(error), index_name, scope_name }, "Failed to run Search (FTS) query");
		const message = error instanceof Error ? error.message : String(error);
		const kind = classifyCouchbaseError(error);
		// A malformed query body comes back as InternalServerFailureError from the Search
		// service (verified live with `{ not_a_query: 1 }`), which is indistinguishable by
		// class from a genuine server fault -- so the advice covers both readings.
		const envelope = buildToolErrorEnvelope({
			kind,
			message: `Failed to run Search query: ${message}`,
			advice:
				'Check the index name first with capella_list_fts_indexes (a scope-level index is bare with bucket_name+scope_name, dotted without). If the name is right, the query body may be malformed: it is raw FTS JSON such as {"match": "text", "field": "name"} or {"match_all": {}}.',
		});
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_run_fts_query",
		{
			description:
				"Run a Search (FTS) query against an index and return matching rows with their scores. The query is raw FTS JSON supporting any non-vector query type (match, match_phrase, term, conjuncts, disjuncts, geo, range, query_string). Read-only.",
			inputSchema: {
				index_name: z
					.string()
					.describe(
						'Index to search. Bare ("myIndex") with bucket_name and scope_name; dotted ("bucket.scope.myIndex") without them.',
					),
				query: z
					.record(z.string(), z.unknown())
					.describe(
						'Raw FTS query JSON, e.g. {"match": "timeout", "field": "message"}, {"match_all": {}}, or {"conjuncts": [...]}.',
					),
				limit: z
					.number()
					.int()
					.positive()
					.max(MAX_FTS_LIMIT)
					.optional()
					.describe(`Maximum rows to return (default ${DEFAULT_FTS_LIMIT}, max ${MAX_FTS_LIMIT}).`),
				fields: z.array(z.string()).optional().describe("Document fields to return alongside each hit."),
				explain: z
					.boolean()
					.optional()
					.describe("Return the scoring explanation for the top hit. Forces limit to 1; still executes the query."),
				bucket_name: z.string().optional().describe("Bucket of a scope-level index. Pass with scope_name."),
				scope_name: z.string().optional().describe("Scope of a scope-level index. Requires bucket_name."),
			},
			annotations: couchbaseToolAnnotations("capella_run_fts_query"),
		},
		async (params) => {
			logger.info({ index: params.index_name, scope: params.scope_name }, "Running Search (FTS) query");
			return runFtsQuery(params, bucket);
		},
	);
};
