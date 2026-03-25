/* src/tools/createDocumentation.ts */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { z } from "zod";
import { config } from "../config";
import { createError } from "../lib/errors";
import { logger } from "../lib/logger";

// Function to sanitize file paths to prevent directory traversal
const sanitizePath = (inputPath: string): string => {
	return path.normalize(inputPath).replace(/^(\.\.(\/|\\|$))+/, "");
};

export default (server: McpServer, _bucket: Bucket) => {
	server.tool(
		"create_documentation",
		"Create or update documentation for a scope, collection, or specific file",
		{
			scope_name: z.string().describe("Name of the scope"),
			collection_name: z.string().optional().describe("Name of the collection (optional)"),
			file_name: z.string().optional().describe("Name of the document file (without extension, optional)"),
			content: z.string().describe("Markdown content for the documentation"),
		},
		async ({ scope_name, collection_name, file_name, content }) => {
			if (!config.documentation?.enabled) {
				return {
					content: [{ type: "text", text: "Documentation tools are disabled in the server configuration." }],
				};
			}
			// Always define baseDirectory here
			const baseDirectory = config.documentation.baseDirectory || "./docs";
			// Debugging logs
			logger.debug(
				{
					baseDirectory,
					cwd: process.cwd(),
					user: process.env.USER,
					uid: process.getuid?.(),
					gid: process.getgid?.(),
					scope_name,
					collection_name,
					file_name,
				},
				"[create_documentation] Debug info",
			);
			try {
				logger.info(
					{
						scope: scope_name,
						collection: collection_name,
						file: file_name,
					},
					"Creating/updating documentation",
				);

				if (!content) {
					throw createError("VALIDATION_ERROR", "Content is required");
				}

				// Determine the path for the documentation
				let docPath: string;
				if (collection_name && file_name) {
					// Specific file in collection
					const collectionDir = path.join(baseDirectory, sanitizePath(scope_name), sanitizePath(collection_name));
					await fs.mkdir(collectionDir, { recursive: true });
					docPath = path.join(
						collectionDir,
						`${sanitizePath(file_name)}${config.documentation?.fileExtension || ".md"}`,
					);
				} else if (collection_name) {
					// Collection index file
					const collectionDir = path.join(baseDirectory, sanitizePath(scope_name), sanitizePath(collection_name));
					await fs.mkdir(collectionDir, { recursive: true });
					docPath = path.join(collectionDir, `index${config.documentation?.fileExtension || ".md"}`);
				} else {
					// Scope index file
					const scopeDir = path.join(baseDirectory, sanitizePath(scope_name));
					await fs.mkdir(scopeDir, { recursive: true });
					docPath = path.join(scopeDir, `index${config.documentation?.fileExtension || ".md"}`);
				}
				// Debugging log for docPath
				logger.debug({ docPath }, "[create_documentation] Writing documentation file to");

				// Write the documentation file
				await fs.writeFile(docPath, content, "utf-8");

				const filePath = path.relative(baseDirectory, docPath);
				const docsUri =
					collection_name && file_name
						? `docs://${scope_name}/${collection_name}/${file_name}`
						: collection_name
							? `docs://${scope_name}/${collection_name}`
							: `docs://${scope_name}`;

				return {
					content: [
						{
							type: "text",
							text: `Documentation successfully created/updated at ${filePath}\nAccess it via resource URI: ${docsUri}`,
						},
					],
				};
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : String(error),
						scope: scope_name,
						collection: collection_name,
						file: file_name,
					},
					"Error creating/updating documentation",
				);
				throw error;
			}
		},
	);
};
