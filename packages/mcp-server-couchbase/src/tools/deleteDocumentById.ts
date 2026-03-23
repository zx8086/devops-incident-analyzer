/* src/tools/deleteDocumentById.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { createError } from "../lib/errors";
import { logger } from "../lib/logger";

export default (server: McpServer, bucket: Bucket) => {
	server.tool(
		"delete_document_by_id",
		"Delete a document by ID from a specific scope and collection",
		{
			scope_name: z.string().describe("Name of the scope"),
			collection_name: z.string().describe("Name of the collection"),
			document_id: z.string().describe("ID of the document to delete"),
		},
		async ({ scope_name, collection_name, document_id }) => {
			try {
				logger.info(
					{
						scope_name,
						collection_name,
						document_id,
					},
					"Processing document deletion:",
				);

				if (!bucket) {
					throw createError("DB_ERROR", "Bucket is not initialized");
				}

				const collection = bucket.scope(scope_name).collection(collection_name);
				await collection.remove(document_id);

				logger.info(
					{
						scope: scope_name,
						collection: collection_name,
						id: document_id,
					},
					"Document deleted successfully",
				);

				return {
					content: [
						{
							type: "text",
							text: `Document ${document_id} successfully deleted from ${scope_name}/${collection_name}`,
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "Error in delete_document_by_id");
				throw error;
			}
		},
	);
};
