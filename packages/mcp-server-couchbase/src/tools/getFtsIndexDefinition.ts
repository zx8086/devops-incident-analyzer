/* src/tools/getFtsIndexDefinition.ts */

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { classifyCouchbaseError, summarizeCouchbaseError } from "../lib/classifyCouchbaseError";
import { assertScopeArgs } from "../lib/ftsIndexes";
import { resolveBucket } from "../lib/resolveBucket";
import { logger } from "../utils/logger";
import { couchbaseToolAnnotations } from "./tool-classification";

// Exported for unit testing.
export const getFtsIndexDefinition = async (
	params: { index_name: string; bucket_name?: string; scope_name?: string },
	bucket: Bucket,
) => {
	const { index_name, bucket_name, scope_name } = params;

	const argError = assertScopeArgs(bucket_name, scope_name);
	if (argError) {
		const envelope = buildToolErrorEnvelope({ kind: "bad-input", message: argError });
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}

	try {
		// A scoped index is addressed by its BARE name through the scope manager and by the
		// dotted <bucket>.<scope>.<name> through the cluster -- the wrong pairing throws
		// IndexNotFoundError (verified live), so the advice below names both forms.
		const index = scope_name
			? await resolveBucket(bucket, bucket_name).scope(scope_name).searchIndexes().getIndex(index_name)
			: await bucket.cluster.searchIndexes().getIndex(index_name);

		return {
			content: [{ type: "text" as const, text: JSON.stringify(index, null, 2) }],
			isError: false,
		};
	} catch (error) {
		logger.error(
			{ error: summarizeCouchbaseError(error), index_name, bucket_name, scope_name },
			"Failed to get Search index definition",
		);
		const message = error instanceof Error ? error.message : String(error);
		// IndexNotFoundError classifies as "no-index" -> category no-data, which is
		// NON-degrading: asking for an index that does not exist is a discovery outcome,
		// not a tool malfunction, and must not cap the agent's confidence.
		const kind = classifyCouchbaseError(error);
		const envelope = buildToolErrorEnvelope({
			kind,
			message: `Failed to get Search index definition: ${message}`,
			advice:
				'A scope-level index is named bare ("myIndex") when bucket_name and scope_name are passed, and dotted ("bucket.scope.myIndex") when they are not. Run capella_list_fts_indexes to see which names exist at which level.',
		});
		return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], isError: true };
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.registerTool(
		"capella_get_fts_index_definition",
		{
			description:
				"Get one Search (FTS) index's full definition: mappings, analyzers, type filters and plan params. Large output -- use capella_list_fts_indexes first to find the index name.",
			inputSchema: {
				index_name: z
					.string()
					.describe(
						'Index name. Bare ("myIndex") with bucket_name and scope_name; dotted ("bucket.scope.myIndex") without them.',
					),
				bucket_name: z.string().optional().describe("Bucket of a scope-level index. Pass with scope_name."),
				scope_name: z.string().optional().describe("Scope of a scope-level index. Requires bucket_name."),
			},
			annotations: couchbaseToolAnnotations("capella_get_fts_index_definition"),
		},
		async (params) => {
			logger.info({ index: params.index_name, scope: params.scope_name }, "Getting Search index definition");
			return getFtsIndexDefinition(params, bucket);
		},
	);
};
