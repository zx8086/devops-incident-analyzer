// src/resources/documentResource.ts

import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { isNotFoundError } from "../lib/classifyCouchbaseError";
import { ResponseBuilder } from "../lib/responseBuilder";
import type { DocumentContent } from "../lib/types";
import { logger } from "../utils/logger";
import type { ResourceRegistry, TemplateVariables } from "./resource-registry";

export function registerDocumentResource(server: McpServer, bucket: Bucket, registry: ResourceRegistry): void {
	// SIO-1412: single handler const registered on the SDK server AND in couchbase's
	// own registry, so readResourceByUri dispatches without SDK-internal reach-in.
	const documentTemplate = new ResourceTemplate("document://{scope}/{collection}/{id}", {
		list: undefined,
	});
	const readDocument = async (uri: URL, { scope, collection, id }: TemplateVariables) => {
		const scopeName = String(scope ?? "");
		const collectionName = String(collection ?? "");
		const docId = String(id ?? "");
		try {
			logger.info({ scope: scopeName, collection: collectionName, id: docId }, "Fetching document resource");

			try {
				const doc = await bucket.scope(scopeName).collection(collectionName).get(docId);
				return ResponseBuilder.success(doc.content as DocumentContent, "json").buildResourceResponse(uri.href);
			} catch (error) {
				// SIO-1087: classify on the SDK error class (DocumentNotFoundError), not message text.
				if (isNotFoundError(error)) {
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
	};

	server.resource("document", documentTemplate, readDocument);
	registry.addTemplate(documentTemplate, readDocument);

	logger.info("Document resource registered successfully");
}
