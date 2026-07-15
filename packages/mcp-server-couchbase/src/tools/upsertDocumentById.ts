/* src/tools/upsertDocumentById.ts */

import { buildToolErrorEnvelope } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { classifyCouchbaseError } from "../lib/classifyCouchbaseError";
import { logger } from "../utils/logger";

// Exported for unit testing (SIO-1118). Wrap the JSON parse + direct SDK upsert()
// so an SDK error (CAS/validation/timeout) or invalid content surfaces as a
// structured envelope rather than an uncaught throw -- the raw throw reaches the
// agent as category "unknown" (degrading) and caps confidence. Mirrors the
// SIO-1117 getDocument() pattern. Invalid JSON classifies to kind "unknown".
export const upsertDocument = async (
	params: { scope_name: string; collection_name: string; document_id: string; document_content: string },
	bucket: Bucket,
) => {
	const { scope_name, collection_name, document_id, document_content } = params;
	try {
		let content: unknown;
		try {
			content = JSON.parse(document_content);
		} catch (_e) {
			throw new Error("Invalid JSON content");
		}

		const collection = bucket.scope(scope_name).collection(collection_name);
		await collection.upsert(document_id, content);
		return {
			content: [
				{
					type: "text" as const,
					text: `Document ${document_id} successfully upserted in ${scope_name}/${collection_name}`,
				},
			],
			isError: false,
		};
	} catch (error) {
		logger.error({ error, scope_name, collection_name, document_id }, "Failed to upsert document by id");
		const message = error instanceof Error ? error.message : String(error);
		// SIO-1118: classify on the SDK error CLASS and emit the shared { _error: { kind, category } }
		// envelope. A generic SDK/validation error becomes kind "unknown"; a recognized SDK error
		// (e.g. TimeoutError -> "timeout") gets its precise kind so the agent reads it structurally.
		const kind = classifyCouchbaseError(error);
		const envelope = buildToolErrorEnvelope({ kind, message: `Failed to upsert document by id: ${message}` });
		return {
			content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
			isError: true,
		};
	}
};

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"capella_upsert_document_by_id",
		"Create or update a document with a specific ID",
		{
			scope_name: z.string().describe("Name of the scope"),
			collection_name: z.string().describe("Name of the collection"),
			document_id: z.string().describe("ID of the document to create or update"),
			document_content: z.string().describe("JSON content of the document"),
		},
		async (params) => upsertDocument(params, bucket),
	);
};
