/* src/tools/deleteDocumentById.ts */

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { classifyCouchbaseError } from "../lib/classifyCouchbaseError";
import { logger } from "../utils/logger";

// Exported for unit testing (SIO-1118). Wrap the direct SDK remove() so a missing
// document surfaces as a structured not-found envelope rather than an uncaught
// DocumentNotFoundError -- the raw throw reaches the agent as category "unknown"
// (degrading) and caps confidence; not-found is a routine finding that must not.
// Mirrors the SIO-1117 getDocument() pattern.
export const deleteDocument = async (
	params: { scope_name: string; collection_name: string; document_id: string },
	bucket: Bucket,
) => {
	const { scope_name, collection_name, document_id } = params;
	try {
		const collection = bucket.scope(scope_name).collection(collection_name);
		await collection.remove(document_id);
		return {
			content: [
				{
					type: "text" as const,
					text: `Document ${document_id} successfully deleted from ${scope_name}/${collection_name}`,
				},
			],
			isError: false,
		};
	} catch (error) {
		logger.error({ error, scope_name, collection_name, document_id }, "Failed to delete document by id");
		const message = error instanceof Error ? error.message : String(error);
		// SIO-1118: classify on the SDK error CLASS (DocumentNotFoundError) and emit the shared
		// { _error: { kind, category } } envelope. A missing document becomes kind "not-found"
		// (category not-found, non-degrading) so it does NOT cap confidence.
		const kind = classifyCouchbaseError(error);
		const envelope = buildToolErrorEnvelope({ kind, message: `Failed to delete document by id: ${message}` });
		return {
			content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
			isError: true,
		};
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_delete_document_by_id",
		"Delete a document by ID from a specific scope and collection",
		{
			scope_name: z.string().describe("Name of the scope"),
			collection_name: z.string().describe("Name of the collection"),
			document_id: z.string().describe("ID of the document to delete"),
		},
		async (params) => deleteDocument(params, bucket),
	);
};
