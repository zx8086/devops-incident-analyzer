// src/tools/listFtsIndexes.ts

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
			// SIO-1823 (review): a TOTAL enumeration failure must not read as success. With
			// every scope unreadable -- Search authorization revoked, the service down -- the
			// loop above would otherwise return `indexes: []` with isError false, which the
			// agent cannot tell from "this bucket genuinely has no Search indexes". Reporting
			// absence when the lookup failed is the worse of the two errors.
			//
			// A PARTIAL failure still returns what was read: those indexes are real, and
			// naming the unreadable scopes lets the agent qualify the answer.
			if (skipped.length > 0 && indexes.length === 0) {
				const envelope = buildToolErrorEnvelope({
					// "server-error", not "not-found": the distinction is the whole point of this
					// branch. not-found would tell the agent the indexes are absent, which is the
					// false conclusion being prevented.
					kind: "server-error",
					message: `Could not read Search indexes from any scope in "${bucket_name}" (${skipped.length} of ${scopes.length} scopes failed). This is a lookup failure, NOT evidence that the bucket has no Search indexes.`,
					advice:
						'Check the Search service is running and the credentials carry Search permissions on this bucket. capella_get_cluster_health with service_types ["search"] shows whether the service answers at all.',
				});
				return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
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
