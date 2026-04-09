/* src/tools/listDocumentation.ts */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { config } from "../config";
import { logger } from "../utils/logger";

export default (server: McpServer, _bucket: Bucket) => {
	server.tool(
		"capella_list_documentation",
		"List available documentation resources",
		{
			scope_name: z.string().optional().describe("Name of the scope to list documentation for"),
			collection_name: z.string().optional().describe("Name of the collection to list documentation for"),
		},
		async ({ scope_name, collection_name }) => {
			if (!config.documentation?.enabled) {
				return {
					content: [{ type: "text", text: "Documentation tools are disabled in the server configuration." }],
				};
			}

			let resourceUri: string;

			if (!scope_name) {
				resourceUri = "docs://";
			} else if (collection_name) {
				resourceUri = `docs://${scope_name}/${collection_name}`;
			} else {
				resourceUri = `docs://${scope_name}`;
			}

			try {
				logger.info(
					{
						resourceUri,
						scope: scope_name,
						collection: collection_name,
					},
					"Listing documentation",
				);

				// Use the resource URI handler to get documentation listing
				const resourceResult = await (
					server as unknown as Record<
						string,
						(uri: string) => Promise<{ contents?: Array<{ mimeType?: string; text?: string }> }>
					>
				).readResourceByUri!(resourceUri);

				if (!resourceResult || !resourceResult.contents || resourceResult.contents.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No documentation found at ${resourceUri}`,
							},
						],
					};
				}

				// Map the resource content to the tool response format
				return {
					content: resourceResult.contents.map((content: { mimeType?: string; text?: string }) => ({
						type: "text" as const,
						text: content.text || `[Binary content of type ${content.mimeType}]`,
					})),
				};
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : String(error),
						resourceUri,
						scope: scope_name,
						collection: collection_name,
					},
					"Error listing documentation",
				);

				return {
					content: [
						{
							type: "text",
							text: `Error listing documentation: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);
};
