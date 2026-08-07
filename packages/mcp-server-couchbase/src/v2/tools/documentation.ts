// src/v2/tools/documentation.ts
//
// SIO-1443: v2 port of the 5 documentation tools (create/list/delete/sync/read markdown docs under
// config.documentation.baseDirectory). Re-implemented against @modelcontextprotocol/server's
// registerTool config style -- v1's tool files (packages/mcp-server-couchbase/src/tools/*.ts)
// import McpServer from @modelcontextprotocol/sdk, a different package, so they are read as
// reference only, not imported. Handler bodies are ported verbatim; only the server/registration
// plumbing changes. Annotations are hand-written per tool below (see tool-classification.ts's
// READ_ONLY_TOOLS/WRITE_TOOLS/DESTRUCTIVE_TOOLS for the source of truth) since
// couchbaseToolAnnotations() itself is v1-only (imports ToolAnnotations from the v1 SDK's types
// module).
//
// capella_list_documentation and capella_read_documentation dispatch through v1's
// server.readResourceByUri, a method assigned onto the boot-template McpServer by
// server.ts/buildReadResourceByUri (SIO-1412) that fronts an MCP "resources" registry v2 does not
// have (Task 1's server-v2.ts registers tools only, no resources -- see its header comment). v2 has
// no resource registry to dispatch against, so the docs:// resolution these two tools need is
// inlined here as resolveDocsUri(), scoped to exactly the docs:// shapes
// DocumentationHandler/buildReadResourceByUri produce (root: real filesystem listing; scoped:
// placeholder text, ported verbatim from documentationResource.ts's
// getScopeDocumentation/getCollectionDocumentation/getDocumentationFile). The playbook:// fast path
// and the generic ResourceRegistry fallback are out of scope -- no v2 playbook or resource tools
// exist yet to need them.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer, RegisteredTool, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "../../config";
import { connectionManager } from "../../lib/connectionManager";
import { createError } from "../../lib/errors";
import { logger } from "../../utils/logger";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
const WRITE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

// Ported verbatim from createDocumentation.ts / deleteDocumentation.ts / syncDocumentation.ts
// (all three define the identical function). Security-relevant path-traversal guard -- must not
// be paraphrased or simplified.
function sanitizePath(inputPath: string): string {
	return path.normalize(inputPath).replace(/^(\.\.(\/|\\|$))+/, "");
}

interface DocsResourceContent {
	contents?: Array<{ mimeType?: string; text?: string }>;
}

// Ported from documentationResource.ts's DocumentationHandler.listDocumentation -- the only docs://
// level that touches the filesystem for real (root: enumerate scope/collection directories).
async function listDocumentationRoot(baseDirectory: string): Promise<DocsResourceContent> {
	try {
		const dirEntries = await fs.readdir(baseDirectory, { withFileTypes: true });
		const scopes = dirEntries.filter((entry) => entry.isDirectory()).map((dir) => dir.name);

		let documentationText = "# Documentation Browser\n\n";
		documentationText += "Browse documentation for database scopes and collections.\n\n";

		if (scopes.length > 0) {
			documentationText += "## Available Scopes\n\n";

			for (const scope of scopes) {
				documentationText += `- ${scope}\n`;

				try {
					const scopePath = path.join(baseDirectory, sanitizePath(scope));
					const scopeDirEntries = await fs.readdir(scopePath, { withFileTypes: true });
					const collections = scopeDirEntries.filter((entry) => entry.isDirectory()).map((dir) => dir.name);

					if (collections.length > 0) {
						documentationText += "  Collections:\n";
						for (const collection of collections) {
							documentationText += `  - ${collection}\n`;
						}
					}
				} catch (_err) {
					// Ignore read errors for collections
				}
			}
		} else {
			documentationText += "No documentation is available yet.";
		}

		return { contents: [{ mimeType: "text/markdown", text: documentationText }] };
	} catch (error) {
		logger.error(
			{ error: error instanceof Error ? error.message : String(error) },
			"Error browsing documentation structure",
		);
		return {
			contents: [
				{
					mimeType: "text/plain",
					text: `Error browsing documentation: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
}

// Ported from documentationResource.ts's getScopeDocumentation/getCollectionDocumentation/
// getDocumentationFile -- these are placeholder responses in v1 too (they do not read the
// filesystem), so the port preserves that behavior rather than inventing real lookups.
function scopeDocumentationPlaceholder(scope: string): DocsResourceContent {
	return {
		contents: [
			{
				mimeType: "text/markdown",
				text: `# Scope Documentation\n\nThis is a placeholder for documentation about the ${scope} scope.\n\nThe detailed scope documentation is not yet available.`,
			},
		],
	};
}

function collectionDocumentationPlaceholder(scope: string, collection: string): DocsResourceContent {
	return {
		contents: [
			{
				mimeType: "text/markdown",
				text: `# Collection Documentation\n\nThis is a placeholder for documentation about the ${collection} collection in the ${scope} scope.\n\nThe detailed collection documentation is not yet available.`,
			},
		],
	};
}

function documentationFilePlaceholder(scope: string, collection: string, file: string): DocsResourceContent {
	return {
		contents: [
			{
				mimeType: "text/markdown",
				text: `# Documentation File\n\nThis is a placeholder for the documentation file ${file} in the ${collection} collection of the ${scope} scope.\n\nThe detailed file documentation is not yet available.`,
			},
		],
	};
}

// Mirrors server.ts's buildReadResourceByUri docs:// fast path (SIO-1052), scoped to the shapes
// capella_list_documentation / capella_read_documentation actually request.
async function resolveDocsUri(resourceUri: string): Promise<DocsResourceContent> {
	const rest = resourceUri.split("://")[1] || "";
	const parts = rest === "" ? [] : rest.split("/");
	const [scope = "", collection = ""] = parts;

	if (parts.length === 0) {
		return listDocumentationRoot(config.documentation.baseDirectory || "./docs");
	}
	if (parts.length === 1) {
		return scopeDocumentationPlaceholder(scope);
	}
	if (parts.length === 2) {
		return collectionDocumentationPlaceholder(scope, collection);
	}
	return documentationFilePlaceholder(scope, collection, parts.slice(2).join("/"));
}

export function registerDocumentationToolsV2(server: McpServer, tools: Map<string, RegisteredTool>): void {
	const createDocumentation = server.registerTool(
		"capella_create_documentation",
		{
			description: "Create or update documentation for a scope, collection, or specific file",
			inputSchema: z.object({
				scope_name: z.string().describe("Name of the scope"),
				collection_name: z.string().optional().describe("Name of the collection (optional)"),
				file_name: z.string().optional().describe("Name of the document file (without extension, optional)"),
				content: z.string().describe("Markdown content for the documentation"),
			}),
			annotations: WRITE_ANNOTATIONS,
		},
		async ({ scope_name, collection_name, file_name, content }) => {
			if (!config.documentation.enabled) {
				return {
					content: [{ type: "text" as const, text: "Documentation tools are disabled in the server configuration." }],
				};
			}
			const baseDirectory = config.documentation.baseDirectory || "./docs";
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
					{ scope: scope_name, collection: collection_name, file: file_name },
					"Creating/updating documentation",
				);

				if (!content) {
					throw createError("VALIDATION_ERROR", "Content is required");
				}

				let docPath: string;
				if (collection_name && file_name) {
					const collectionDir = path.join(baseDirectory, sanitizePath(scope_name), sanitizePath(collection_name));
					await fs.mkdir(collectionDir, { recursive: true });
					docPath = path.join(
						collectionDir,
						`${sanitizePath(file_name)}${config.documentation.fileExtension || ".md"}`,
					);
				} else if (collection_name) {
					const collectionDir = path.join(baseDirectory, sanitizePath(scope_name), sanitizePath(collection_name));
					await fs.mkdir(collectionDir, { recursive: true });
					docPath = path.join(collectionDir, `index${config.documentation.fileExtension || ".md"}`);
				} else {
					const scopeDir = path.join(baseDirectory, sanitizePath(scope_name));
					await fs.mkdir(scopeDir, { recursive: true });
					docPath = path.join(scopeDir, `index${config.documentation.fileExtension || ".md"}`);
				}
				logger.debug({ docPath }, "[create_documentation] Writing documentation file to");

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
							type: "text" as const,
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
	tools.set("capella_create_documentation", createDocumentation);

	const listDocumentation = server.registerTool(
		"capella_list_documentation",
		{
			description: "List available documentation resources",
			inputSchema: z.object({
				scope_name: z.string().optional().describe("Name of the scope to list documentation for"),
				collection_name: z.string().optional().describe("Name of the collection to list documentation for"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ scope_name, collection_name }) => {
			if (!config.documentation.enabled) {
				return {
					content: [{ type: "text" as const, text: "Documentation tools are disabled in the server configuration." }],
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
				logger.info({ resourceUri, scope: scope_name, collection: collection_name }, "Listing documentation");

				const resourceResult = await resolveDocsUri(resourceUri);

				if (!resourceResult?.contents?.length) {
					return { content: [{ type: "text" as const, text: `No documentation found at ${resourceUri}` }] };
				}

				return {
					content: resourceResult.contents.map((content) => ({
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
							type: "text" as const,
							text: `Error listing documentation: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);
	tools.set("capella_list_documentation", listDocumentation);

	const deleteDocumentation = server.registerTool(
		"capella_delete_documentation",
		{
			description: "Delete documentation for a scope, collection, or specific file",
			inputSchema: z.object({
				scope_name: z.string().describe("Name of the scope"),
				collection_name: z.string().optional().describe("Name of the collection (optional)"),
				file_name: z.string().optional().describe("Name of the document file (without extension, optional)"),
				recursive: z
					.boolean()
					.optional()
					.describe("Whether to recursively delete all documentation under the specified path"),
			}),
			annotations: DESTRUCTIVE_ANNOTATIONS,
		},
		async ({ scope_name, collection_name, file_name, recursive }) => {
			if (!config.documentation.enabled) {
				return {
					content: [{ type: "text" as const, text: "Documentation tools are disabled in the server configuration." }],
				};
			}
			const baseDirectory = config.documentation.baseDirectory || "./docs";
			try {
				logger.info(
					{ scope: scope_name, collection: collection_name, file: file_name, recursive },
					"Deleting documentation",
				);

				let docPath: string;
				if (collection_name && file_name) {
					docPath = path.join(
						baseDirectory,
						sanitizePath(scope_name),
						sanitizePath(collection_name),
						`${sanitizePath(file_name)}${config.documentation.fileExtension || ".md"}`,
					);
				} else if (collection_name) {
					docPath = path.join(baseDirectory, sanitizePath(scope_name), sanitizePath(collection_name));
				} else {
					docPath = path.join(baseDirectory, sanitizePath(scope_name));
				}

				try {
					await fs.access(docPath);
				} catch (_error) {
					throw createError("NOT_FOUND", "Documentation not found at the specified path");
				}

				if (recursive && (collection_name || !file_name)) {
					await fs.rm(docPath, { recursive: true, force: true });
				} else {
					await fs.unlink(docPath);
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Documentation successfully deleted at ${path.relative(baseDirectory, docPath)}`,
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
					"Error deleting documentation",
				);
				throw error;
			}
		},
	);
	tools.set("capella_delete_documentation", deleteDocumentation);

	const syncDocumentation = server.registerTool(
		"capella_sync_documentation_with_database",
		{
			description: "Generate a documentation skeleton based on the database structure",
			inputSchema: z.object({
				scope_name: z
					.string()
					.optional()
					.describe("Name of the scope to sync (optional, syncs all scopes if not provided)"),
			}),
			annotations: WRITE_ANNOTATIONS,
		},
		async ({ scope_name }) => {
			if (!config.documentation.enabled) {
				return {
					content: [{ type: "text" as const, text: "Documentation tools are disabled in the server configuration." }],
				};
			}
			const baseDirectory = config.documentation.baseDirectory || "./docs";
			logger.debug(
				{
					baseDirectory,
					cwd: process.cwd(),
					user: process.env.USER,
					uid: process.getuid?.(),
					gid: process.getgid?.(),
					scope_name,
				},
				"[sync_documentation_with_database] Debug info",
			);
			try {
				logger.info({ scope: scope_name }, "Syncing documentation with database structure");

				const bucketName = config.database.bucketName;
				const cluster = connectionManager.getCluster();
				if (!cluster) {
					throw new Error("Cluster connection is not available");
				}
				const query = scope_name
					? "SELECT `scope`, `name` AS collection_name FROM system:keyspaces WHERE `bucket` = $bucket AND `scope` = $scope"
					: "SELECT `scope`, `name` AS collection_name FROM system:keyspaces WHERE `bucket` = $bucket";
				const parameters = scope_name ? { scope: scope_name, bucket: bucketName } : { bucket: bucketName };
				logger.debug({ query, parameters }, "[sync_documentation_with_database] Querying collections");

				const result = await cluster.query(query, { parameters });
				logger.debug({ rows: result.rows }, "[sync_documentation_with_database] Query result");

				const scopes = new Map<string, Set<string>>();
				for (const row of result.rows as Array<{ scope?: string; collection_name?: string }>) {
					const { scope, collection_name } = row;
					if (!scope || !collection_name) continue;
					if (!scopes.has(scope)) {
						scopes.set(scope, new Set());
					}
					scopes.get(scope)?.add(collection_name);
				}

				for (const [scope, collections] of scopes) {
					const scopeDir = path.join(baseDirectory, sanitizePath(scope));
					logger.debug({ scopeDir }, "[sync_documentation_with_database] Creating scopeDir");
					await fs.mkdir(scopeDir, { recursive: true });

					const scopeIndexPath = path.join(scopeDir, `index${config.documentation.fileExtension || ".md"}`);
					try {
						await fs.access(scopeIndexPath);
					} catch {
						logger.debug({ scopeIndexPath }, "[sync_documentation_with_database] Writing scope index");
						await fs.writeFile(
							scopeIndexPath,
							`# ${scope} Scope\n\n` +
								"This scope contains the following collections:\n\n" +
								Array.from(collections)
									.map((c) => `- [${c}](docs://${scope}/${c})`)
									.join("\n") +
								"\n",
						);
					}

					for (const collection of collections) {
						const collectionDir = path.join(scopeDir, sanitizePath(collection));
						logger.debug({ collectionDir }, "[sync_documentation_with_database] Creating collectionDir");
						await fs.mkdir(collectionDir, { recursive: true });

						const collectionIndexPath = path.join(collectionDir, `index${config.documentation.fileExtension || ".md"}`);
						try {
							await fs.access(collectionIndexPath);
						} catch {
							logger.debug({ collectionIndexPath }, "[sync_documentation_with_database] Writing collection index");
							await fs.writeFile(
								collectionIndexPath,
								`# ${collection} Collection\n\n` +
									`This collection is part of the [${scope}](docs://${scope}) scope.\n\n` +
									"## Schema\n\n" +
									"The schema for this collection will be documented here.\n\n" +
									"## Usage\n\n" +
									"Documentation for using this collection will be added here.\n",
							);
						}
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text:
								"Documentation structure successfully synchronized with database.\n" +
								`Generated documentation for ${scopes.size} scope(s) and ` +
								`${Array.from(scopes.values()).reduce((sum, cols) => sum + cols.size, 0)} collection(s).`,
						},
					],
				};
			} catch (error) {
				logger.error(
					{ error: error instanceof Error ? error.stack || error.message : String(error), scope: scope_name },
					"Error syncing documentation",
				);
				throw error;
			}
		},
	);
	tools.set("capella_sync_documentation_with_database", syncDocumentation);

	const readDocumentation = server.registerTool(
		"capella_read_documentation",
		{
			description: "Read documentation content using the resource protocol",
			inputSchema: z.object({
				scope_name: z.string().optional().describe("Name of the scope (optional)"),
				collection_name: z.string().optional().describe("Name of the collection (optional)"),
				file_name: z.string().optional().describe("Name of the document file (without extension, optional)"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ scope_name, collection_name, file_name }) => {
			let resourceUri: string;
			if (!scope_name) {
				resourceUri = "docs://";
			} else if (collection_name && file_name) {
				resourceUri = `docs://${scope_name}/${collection_name}/${file_name}`;
			} else if (collection_name) {
				resourceUri = `docs://${scope_name}/${collection_name}`;
			} else {
				resourceUri = `docs://${scope_name}`;
			}

			try {
				logger.info(
					{ resourceUri, scope: scope_name, collection: collection_name, file: file_name },
					"Reading documentation",
				);

				const resourceResult = await resolveDocsUri(resourceUri);

				if (!resourceResult?.contents?.length) {
					return { content: [{ type: "text" as const, text: `No documentation found at ${resourceUri}` }] };
				}

				return {
					content: resourceResult.contents.map((content) => ({
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
						file: file_name,
					},
					"Error reading documentation",
				);

				return {
					content: [
						{
							type: "text" as const,
							text: `Error reading documentation: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);
	tools.set("capella_read_documentation", readDocumentation);
}
