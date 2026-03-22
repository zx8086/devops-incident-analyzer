/* src/lib/resourceHandlers.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CapellaConn } from "../types";
import { createError } from "./errors";
import { logger } from "./logger";

export function registerResources(server: McpServer, capellaConn: CapellaConn): void {
	server.tool("get_server_info", "Get server information", {}, async () => ({
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
		"get_document_by_path",
		"Get a document by its path",
		{
			bucketName: "string",
			scopeName: "string",
			collectionName: "string",
			documentId: "string",
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
				logger.error(`Error getting document ${bucketName}/${scopeName}/${collectionName}/${documentId}`, { error });
				throw error;
			}
		},
	);

	// Bucket info tool
	server.tool(
		"get_bucket_info",
		"Get bucket information",
		{
			bucketName: "string",
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
				logger.error(`Error getting bucket info for ${bucketName}`, { error });
				throw error;
			}
		},
	);

	logger.info("Resource handlers registered successfully");
}
