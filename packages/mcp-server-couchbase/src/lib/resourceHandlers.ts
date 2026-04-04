/* src/lib/resourceHandlers.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CapellaConn } from "../types";
import { createError } from "./errors";
import { logger } from "../utils/logger";

export function registerResources(server: McpServer, capellaConn: CapellaConn): void {
	server.tool("capella_get_server_info", "Get server information", {}, async () => ({
		content: [
			{
				type: "text",
				text: JSON.stringify(
					{
						server: "Couchbase Capella",
						version: "1.0.0",
						capabilities: ["SQL++", "JSON", "KeyValue"],
					},
					null,
					2,
				),
			},
		],
	}));

	server.tool(
		"capella_get_document_by_path",
		"Get a document by its path",
		{
			bucketName: z.string().describe("Bucket name"),
			scopeName: z.string().describe("Scope name"),
			collectionName: z.string().describe("Collection name"),
			documentId: z.string().describe("Document ID"),
		},
		async ({ bucketName, scopeName, collectionName, documentId }) => {
			try {
				if (!capellaConn.defaultBucket) {
					throw createError("DB_ERROR", "Bucket is not initialized");
				}

				const collection = capellaConn.defaultBucket.scope(scopeName).collection(collectionName);
				const result = await collection.get(documentId);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(result.content, null, 2),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, `Error getting document ${bucketName}/${scopeName}/${collectionName}/${documentId}`);
				throw error;
			}
		},
	);

	// Bucket info tool
	server.tool(
		"capella_get_bucket_info",
		"Get bucket information",
		{
			bucketName: z.string().describe("Bucket name"),
		},
		async ({ bucketName }) => {
			try {
				if (!capellaConn.defaultBucket) {
					throw createError("DB_ERROR", "Bucket is not initialized");
				}

				const scopes = await capellaConn.defaultBucket.collections().getAllScopes();

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									bucket: bucketName,
									scopes: scopes.map((scope) => ({
										name: scope.name,
										collections: scope.collections.map((coll) => coll.name),
									})),
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, `Error getting bucket info for ${bucketName}`);
				throw error;
			}
		},
	);

	logger.info("Resource handlers registered successfully");
}
