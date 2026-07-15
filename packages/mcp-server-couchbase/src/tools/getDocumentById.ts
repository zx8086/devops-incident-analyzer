/* src/tools/getDocumentById.ts */

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { classifyCouchbaseError } from "../lib/classifyCouchbaseError";

// SIO-1116: extracted from the registration callback (mirrors runSqlPlusPlusQuery's runQuery)
// so the not-found handling is unit-testable. This was the only couchbase tool without a catch;
// a missing document threw DocumentNotFoundError uncaught -> the agent's regex classifier tagged
// it "unknown" (a DEGRADING category that caps confidence) instead of the routine not-found
// finding it is. Emitting the shared { _error: { kind, category } } envelope lets
// classifyCouchbaseError map DocumentNotFoundError -> "not-found" (non-degrading), matching the
// sibling runSqlPlusPlusQuery tool and the document:// resource.
export const getDocumentById = async (
	params: { scope_name: string; collection_name: string; document_id: string },
	bucket: Bucket,
) => {
	try {
		const collection = bucket.scope(params.scope_name).collection(params.collection_name);
		const result = await collection.get(params.document_id);
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result.content, null, 2) }],
		};
	} catch (error) {
		const kind = classifyCouchbaseError(error);
		const message = error instanceof Error ? error.message : String(error);
		const envelope = buildToolErrorEnvelope({ kind, message });
		return {
			content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
			isError: true,
		};
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_get_document_by_id",
		"Get a document by ID from a specific scope and collection",
		{
			scope_name: z.string().describe("Name of the scope"),
			collection_name: z.string().describe("Name of the collection"),
			document_id: z.string().describe("ID of the document to retrieve"),
		},
		async (params, _extra) => getDocumentById(params, bucket),
	);
};
