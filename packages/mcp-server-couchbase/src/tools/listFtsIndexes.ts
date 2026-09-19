/* src/tools/listFtsIndexes.ts */

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { classifyCouchbaseError, summarizeCouchbaseError } from "../lib/classifyCouchbaseError";
import { assertScopeArgs, type FtsIndexSummary, summarizeFtsIndex } from "../lib/ftsIndexes";
import { resolveBucket } from "../lib/resolveBucket";
import { logger } from "../utils/logger";
import { couchbaseToolAnnotations } from "./tool-classification";

// Exported for unit testing.
export const listFtsIndexes = async (params: { bucket_name?: string; scope_name?: string }, bucket: Bucket) => {
	const { bucket_name, scope_name } = params;

	const argError = assertScopeArgs(bucket_name, scope_name);
	if (argError) {
		const envelope = buildToolErrorEnvelope({ kind: "bad-input", message: argError });
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}

	try {
		let indexes: FtsIndexSummary[];

		if (scope_name) {
			const raw = await resolveBucket(bucket, bucket_name).scope(scope_name).searchIndexes().getAllIndexes();
			indexes = raw.map((i) => summarizeFtsIndex(i, scope_name));
		} else if (bucket_name) {
			// No SDK call lists a bucket's Search indexes, so walk its scopes. A scope
			// without the Search service simply returns none; one scope failing must not
			// lose the rest, so per-scope errors are collected rather than thrown.
			const target = resolveBucket(bucket, bucket_name);
			const scopes = await target.collections().getAllScopes();
			indexes = [];
			const skipped: string[] = [];
			for (const scope of scopes) {
				try {
					const raw = await target.scope(scope.name).searchIndexes().getAllIndexes();
					for (const i of raw) indexes.push(summarizeFtsIndex(i, scope.name));
				} catch (error) {
					skipped.push(scope.name);
					logger.warn({ error: summarizeCouchbaseError(error), scope: scope.name }, "Scope index listing failed");
				}
			}
			if (skipped.length > 0) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ indexes, unreadableScopes: skipped }, null, 2) }],
					isError: false,
				};
			}
		} else {
			const raw = await bucket.cluster.searchIndexes().getAllIndexes();
			indexes = raw.map((i) => summarizeFtsIndex(i));
		}

		return {
			content: [{ type: "text" as const, text: JSON.stringify({ indexes }, null, 2) }],
			isError: false,
		};
	} catch (error) {
		logger.error({ error: summarizeCouchbaseError(error), bucket_name, scope_name }, "Failed to list FTS indexes");
		const message = error instanceof Error ? error.message : String(error);
		const kind = classifyCouchbaseError(error);
		const envelope = buildToolErrorEnvelope({
			kind,
			message: `Failed to list Search indexes: ${message}`,
			advice:
				"Without arguments this lists cluster-level index names. Scope-level indexes are addressed by bucket_name plus scope_name.",
		});
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_list_fts_indexes",
		{
			description:
				"List Search (FTS) index names with their type and source. Returns a summary per index, not the full definition -- use capella_get_fts_index_definition for one index's mappings and analyzers. With no arguments, lists cluster-level indexes; with bucket_name, every scope in that bucket; with bucket_name and scope_name, one scope.",
			inputSchema: {
				bucket_name: z
					.string()
					.optional()
					.describe("Bucket to list scope-level Search indexes for. Omit to list cluster-level indexes."),
				scope_name: z.string().optional().describe("Scope to list Search indexes for. Requires bucket_name."),
			},
			annotations: couchbaseToolAnnotations("capella_list_fts_indexes"),
		},
		async (params) => {
			logger.info({ bucket: params.bucket_name, scope: params.scope_name }, "Listing Search indexes");
			return listFtsIndexes(params, bucket);
		},
	);
};
