/* src/resources/databaseStructureResource.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { logger } from "../lib/logger";
import type { BucketInfo } from "../lib/types";

export function registerDatabaseStructureResource(server: McpServer, bucket: Bucket): void {
	server.resource("database-structure", "database://structure", async (uri) => {
		try {
			logger.info("Fetching database structure resource");

			const scopes = await bucket.collections().getAllScopes();
			const _bucketInfo: BucketInfo = {
				name: bucket.name,
				scopes: scopes.map((scope) => ({
					name: scope.name,
					collections: scope.collections.map((coll) => ({
						name: coll.name,
						type: "document", // Default type since CollectionSpec doesn't expose type
					})),
				})),
			};

			let structureText = "# Couchbase Database Structure\n\n";
			structureText += `## Bucket: ${bucket.name}\n\n`;

			let totalScopes = 0;
			let totalCollections = 0;

			for (const scope of scopes) {
				totalScopes++;
				structureText += `### Scope: ${scope.name}\n\n`;

				if (scope.collections.length === 0) {
					structureText += "This scope contains no collections.\n\n";
					continue;
				}

				structureText += "Collections:\n\n";

				for (const coll of scope.collections) {
					totalCollections++;
					structureText += `- **${coll.name}**\n`;
					structureText += `  - Schema URI: \`schema://${scope.name}/${coll.name}\`\n`;
					structureText += `  - Document URI format: \`document://${scope.name}/${coll.name}/{id}\`\n\n`;
				}
			}

			structureText += `## Summary\n\n`;
			structureText += `- Total Scopes: ${totalScopes}\n`;
			structureText += `- Total Collections: ${totalCollections}\n`;

			return {
				contents: [
					{
						uri: uri.href,
						type: "text/markdown",
						text: structureText,
					},
				],
			};
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				"Error fetching database structure",
			);

			return {
				contents: [
					{
						uri: uri.href,
						type: "text/plain",
						text: `Error fetching database structure: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
			};
		}
	});

	logger.info("Database structure resource registered successfully");
}
