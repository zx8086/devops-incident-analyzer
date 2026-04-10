// src/resources/documentResource.ts

import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { ResponseBuilder } from "../lib/responseBuilder";
import type { DocumentContent } from "../lib/types";
import { logger } from "../utils/logger";

export function registerDocumentResource(server: McpServer, bucket: Bucket): void {
	server.resource(
		"document",
		new ResourceTemplate("document://{scope}/{collection}/{id}", {
			list: undefined,
		}),
		async (uri, { scope, collection, id }) => {
			const scopeName = String(scope ?? "");
			const collectionName = String(collection ?? "");
			const docId = String(id ?? "");
			try {
				logger.info({ scope: scopeName, collection: collectionName, id: docId }, "Fetching document resource");

				try {
					const doc = await bucket.scope(scopeName).collection(collectionName).get(docId);
					return ResponseBuilder.success(doc.content as DocumentContent, "json").buildResourceResponse(uri.href);
				} catch (error) {
					if (error instanceof Error && error.message.includes("not found")) {
						return ResponseBuilder.error(`Document not found: ${docId}`).buildResourceResponse(uri.href);
					}
					throw error;
				}
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : String(error),
						scope: scopeName,
						collection: collectionName,
						id: docId,
					},
					"Error fetching document resource",
				);

				return ResponseBuilder.error(
					"Error fetching document resource",
					error instanceof Error ? error : new Error(String(error)),
				).buildResourceResponse(uri.href);
			}
		},
	);

	logger.info("Document resource registered successfully");
}
