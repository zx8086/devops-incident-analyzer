// src/v2/resources.ts
//
// SIO-1443: v2 port of all 11 v1 resources (packages/mcp-server-couchbase/src/resources/*.ts).
// Re-implemented against @modelcontextprotocol/server's registerResource, following the same
// precedent as v2/tools/*.ts: v1's resource files import McpServer from @modelcontextprotocol/sdk
// (a different package), so they are read as reference only, not imported. Handler bodies are
// ported verbatim; only the server/registration plumbing changes.
//
// Resources are NOT chokepoint/logging-wrapped in v1 (server.ts's registerAllResources call sits
// outside the tool-wrapping composition), so this file takes only `server` -- no `tools` Map.
//
// v1's ResourceRegistry / readResourceByUri fallback plumbing (resource-registry.ts, server.ts's
// buildReadResourceByUri) is explicitly OUT OF SCOPE -- it is v1-internal bookkeeping for an
// in-process escape hatch, not part of the actual MCP resources/read protocol handler. Only the
// real registerResource calls are ported; they handle protocol dispatch correctly on their own.
//
// SCHEME-LESS URI FINDING (required investigation before writing this file -- see task-7-brief.md
// Step 2): v1's documentationResource.ts registers 3 resources with bare scheme-less URI strings
// ("scope-documentation", "collection-documentation", "documentation-file" -- no "://"). A
// throwaway probe (server-v2-wire.test.ts-style handler.fetch() harness, deleted after use) proved
// v2's registerResource() ACCEPTS a scheme-less string at registration time, but the actual
// resources/read wire dispatch REJECTS it before the handler ever runs:
//
//   request:  {"method":"resources/read","params":{"uri":"scope-documentation", ...}}
//   response: {"error":{"code":-32602,"message":"Resource URI scope-documentation is invalid",
//              "data":{"uri":"scope-documentation","reason":"invalid_uri"}}}
//
// Appending "://" to both the registered URI and the requested URI made the same request succeed
// (200, handler ran, contents returned). This is a genuine v1/v2 behavioral difference: v1's SDK
// (@modelcontextprotocol/sdk) tolerates a bare scheme-less resource URI at the protocol layer; v2's
// SDK (@modelcontextprotocol/server) requires a parseable URL (scheme + "://" at minimum) and
// rejects anything else with -32602 at the wire layer, before any resource-specific fallback (like
// v1's own toUrl() base-URL trick in resource-registry.ts) could apply even if it were in scope.
// Fix applied below: the 3 affected resources are registered with a trailing "://" appended to
// their v1 name (see each resource's own comment for its exact scheme).
//
// DOCUMENTATION/PLAYBOOK GATING: reuses the SAME config-gate pattern v2/tools/documentation.ts and
// v2/tools/playbooks.ts already established for the identical v1-gating risk on the tool surface
// (config.documentation.enabled; config.playbooks.enabled + full directory-fallback search). The
// gate-checking helper functions in those two files are module-private (not exported), so the
// equivalent logic is re-implemented here against the same v1 reference files
// (documentationResource.ts, playbookResource.ts) rather than imported -- consistent with how
// v2/tools/documentation.ts and v2/tools/playbooks.ts themselves re-implement rather than import
// from v1's resources/*.ts (see those files' own header comments for the same precedent).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { ResourceTemplate } from "@modelcontextprotocol/server";
import { config } from "../config";
import { isNoIndexError, isNotFoundError } from "../lib/classifyCouchbaseError";
import { connectionManager } from "../lib/connectionManager";
import { ResponseBuilder } from "../lib/responseBuilder";
import { sqlppParser } from "../lib/sqlppParser";
import type { DocumentContent } from "../lib/types";
import { logger } from "../utils/logger";

// Ported verbatim from schemaResource.ts's formatDocumentAsSchema.
function formatDocumentAsSchema(doc: DocumentContent): string {
	let schemaText = "# Schema\n\n";

	const formatField = (key: string, value: unknown, level: number = 0): string => {
		const indent = "  ".repeat(level);
		const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

		let fieldText = `${indent}- **${key}**: ${type}`;

		if (type === "object" && value !== null && !Array.isArray(value)) {
			fieldText += "\n";
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				fieldText += formatField(k, v, level + 1);
			}
		} else if (type === "array" && Array.isArray(value) && value.length > 0) {
			const firstItem = value[0];
			const itemType = typeof firstItem;

			if (itemType === "object" && firstItem !== null) {
				fieldText += " of objects\n";
				for (const [k, v] of Object.entries(firstItem as Record<string, unknown>)) {
					fieldText += formatField(`${key}[0].${k}`, v, level + 1);
				}
			} else {
				fieldText += ` of ${itemType}s\n`;
			}
		} else {
			fieldText += "\n";
		}

		return fieldText;
	};

	for (const [key, value] of Object.entries(doc)) {
		schemaText += formatField(key, value);
	}

	return schemaText;
}

// Ported verbatim from documentationResource.ts's sanitizePath (path-traversal guard).
function sanitizePath(inputPath: string): string {
	return path.normalize(inputPath).replace(/^(\.\.(\/|\\|$))+/, "");
}

// Ported verbatim from documentationResource.ts's DocumentationHandler.listDocumentation.
async function listDocumentation(baseDirectory: string) {
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

		return {
			contents: [
				{
					uri: "docs://",
					mimeType: "text/markdown",
					text: documentationText,
				},
			],
		};
	} catch (error) {
		logger.error(
			{ error: error instanceof Error ? error.message : String(error) },
			"Error browsing documentation structure",
		);

		return {
			contents: [
				{
					uri: "docs://",
					mimeType: "text/plain",
					text: `Error browsing documentation: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
}

// Ported verbatim (placeholder responses -- v1 does not read the filesystem for these either).
function getScopeDocumentation(scope: string) {
	return {
		contents: [
			{
				uri: `docs://${scope}`,
				mimeType: "text/markdown",
				text: `# Scope Documentation\n\nThis is a placeholder for documentation about the ${scope} scope.\n\nThe detailed scope documentation is not yet available.`,
			},
		],
	};
}

function getCollectionDocumentation(scope: string, collection: string) {
	return {
		contents: [
			{
				uri: `docs://${scope}/${collection}`,
				mimeType: "text/markdown",
				text: `# Collection Documentation\n\nThis is a placeholder for documentation about the ${collection} collection in the ${scope} scope.\n\nThe detailed collection documentation is not yet available.`,
			},
		],
	};
}

function getDocumentationFile(scope: string, collection: string, file: string) {
	return {
		contents: [
			{
				uri: `docs://${scope}/${collection}/${file}`,
				mimeType: "text/markdown",
				text: `# Documentation File\n\nThis is a placeholder for the documentation file ${file} in the ${collection} collection of the ${scope} scope.\n\nThe detailed file documentation is not yet available.`,
			},
		],
	};
}

// Ported verbatim from playbookResource.ts's PlaybookHandler.listPlaybooks.
async function listPlaybooks(baseDirectory: string, playbookFiles: string[]) {
	try {
		let text = "# Available Playbooks\n\n";

		for (const file of playbookFiles) {
			const resourceId = file.replace(new RegExp(`\\${path.extname(file)}$`), "");
			const filePath = path.join(baseDirectory, file);
			let description = resourceId;

			try {
				const fileContent = await fs.readFile(filePath, "utf-8");
				const firstLine = fileContent.split("\n")[0]?.replace(/^#\s*/, "") || "";
				if (firstLine) description = firstLine;
			} catch (_err) {
				// Ignore read errors when building listing
			}

			text += `- [${description}](playbook://${resourceId})\n`;
		}

		return {
			contents: [
				{
					uri: "playbook://",
					mimeType: "text/markdown",
					text,
				},
			],
		};
	} catch (err) {
		logger.error({ error: err }, "Error generating playbook directory listing");
		return {
			contents: [
				{
					uri: "playbook://",
					mimeType: "text/plain",
					text: `Error listing playbooks: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
		};
	}
}

// Ported verbatim from playbookResource.ts's PlaybookHandler.getPlaybook.
async function getPlaybook(baseDirectory: string, fileExtension: string, playbookFiles: string[], playbookId: string) {
	try {
		if (!playbookId || playbookId === "undefined") {
			logger.warn(`Invalid playbook ID: ${playbookId}`);
			return {
				contents: [{ uri: `playbook://${playbookId}`, mimeType: "text/plain", text: "Error: Invalid playbook ID" }],
			};
		}

		const fileName = `${playbookId}${fileExtension}`;
		const filePath = path.join(baseDirectory, fileName);

		if (!playbookFiles.includes(fileName)) {
			logger.warn(`Playbook not found: ${playbookId}`);
			return {
				contents: [
					{
						uri: `playbook://${playbookId}`,
						mimeType: "text/plain",
						text: `Error: Playbook "${playbookId}" not found`,
					},
				],
			};
		}

		const text = await fs.readFile(filePath, "utf-8");
		return {
			contents: [{ uri: `playbook://${playbookId}`, mimeType: "text/markdown", text }],
		};
	} catch (err) {
		logger.error({ error: err }, `Error reading playbook: ${playbookId}`);
		return {
			contents: [
				{
					uri: `playbook://${playbookId}`,
					mimeType: "text/plain",
					text: `Error reading playbook: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
		};
	}
}

// Ported from playbookResource.ts's loadPlaybooks -- the async directory-probe fallback search
// that determines whether playbook resources are reachable at all. Returns null when playbooks
// are disabled in config, OR none of the fallback directories has a matching markdown file (both
// conditions match v1's PlaybookRegistry === null contract 1:1, same as v2/tools/playbooks.ts's
// resolvePlaybookDirectory). Unlike the tools port (which re-probes per call), resources must know
// the full playbook ID list at REGISTRATION time (one named resource per playbook, not a template),
// so this runs once during registerResourcesV2.
async function loadPlaybookRegistry(): Promise<{ baseDirectory: string; playbookFiles: string[] } | null> {
	if (!config.playbooks?.enabled) {
		logger.info("Playbook resources are disabled in config");
		return null;
	}

	const packageRoot = path.resolve(import.meta.dir, "../..");
	const possibleDirs = [
		config.playbooks?.baseDirectory,
		path.join(process.cwd(), "playbook"),
		path.join(import.meta.dir, "../../playbook"),
		path.join(packageRoot, "playbook"),
	].filter((dir): dir is string => !!dir);

	const fileExtension = config.playbooks.fileExtension || ".md";

	for (const dir of possibleDirs) {
		try {
			await fs.access(dir);
			const files = await fs.readdir(dir);
			const playbookFiles = files.filter((file) => file.endsWith(fileExtension));
			if (playbookFiles.length > 0) {
				logger.info({ count: playbookFiles.length }, `Found playbooks in ${dir}`);
				return { baseDirectory: dir, playbookFiles };
			}
		} catch (_err) {
			// Directory not accessible -- try the next fallback, same as v1's loadPlaybooks.
		}
	}

	logger.warn("No playbook directory found with markdown files; playbook resources disabled");
	return null;
}

// SIO-1443: registers all 11 v1 resources on a fresh v2 McpServer instance. Async (deviates from
// the brief's `(server: McpServer): void` sketch) because the playbook-per-resource loop below
// must know the discovered playbook IDs BEFORE registering (each is its own named resource, not a
// ResourceTemplate) -- mirrors v1's own async loadPlaybooks() + sync registerPlaybookResources()
// split (playbookResource.ts), just collapsed into one function since v2's buildServerFactory is
// already async per request (unlike v1's cached-server-factory, which required the split to stay
// synchronous). server-v2.ts awaits this call.
export async function registerResourcesV2(server: McpServer): Promise<void> {
	// --- Static resources ---

	// Ported verbatim from databaseStructureResource.ts.
	server.registerResource("database-structure", "database://structure", {}, async (uri: URL) => {
		try {
			logger.info("Fetching database structure resource");
			const bucket = await connectionManager.getConnection();
			const scopes = await bucket.collections().getAllScopes();

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

			structureText += "## Summary\n\n";
			structureText += `- Total Scopes: ${totalScopes}\n`;
			structureText += `- Total Collections: ${totalCollections}\n`;

			return {
				contents: [{ uri: uri.href, mimeType: "text/markdown", text: structureText }],
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error fetching database structure",
			);

			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "text/plain",
						text: `Error fetching database structure: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
			};
		}
	});

	// Ported verbatim from documentationResource.ts's documentation-browser registration. Uses a
	// real scheme ("docs://"), so it is NOT affected by the scheme-less URI finding above.
	server.registerResource("documentation-browser", "docs://", {}, async (uri: URL) => {
		logger.info({ uri: uri.href }, "Handling documentation browser request");
		if (!config.documentation?.enabled) {
			// SIO-1443: mirrors v1's gate -- registerAllResources (resources/index.ts) only calls
			// registerMarkdownDocumentationResource when config.documentation.enabled, so under the
			// default (disabled) config this resource is never registered on the SDK server in v1 at
			// all, and a docs:// read falls through to "No resource handler found for URI". v2 has
			// only one registration call site (no conditional registerResource call would be reachable
			// the same way without restructuring registerResourcesV2 itself), so the gate is enforced
			// inside the handler instead, returning the same v1-shaped error text.
			return {
				contents: [
					{ uri: uri.href, mimeType: "text/plain", text: "Error: No resource handler found for URI: docs://" },
				],
			};
		}
		return listDocumentation(config.documentation.baseDirectory || "./docs");
	});

	// SCHEME-LESS URI FIX (see file header for the probe finding): v1 registers these 3 resources
	// with bare scheme-less URI strings ("scope-documentation", "collection-documentation",
	// "documentation-file"). v2's resources/read wire dispatch rejects a scheme-less URI with
	// -32602 "invalid_uri" before any handler runs (confirmed live). Registering with a trailing
	// "://" makes the URI parseable and the handler reachable -- this is a deliberate, minimal
	// scheme addition to preserve v2 reachability, not a silent behavioral change: the resource
	// name and content are otherwise identical to v1's placeholder implementation.
	server.registerResource("scope-documentation", "scope-documentation://", {}, async (uri: URL) => {
		logger.info({ uri: uri.href }, "Handling scope documentation request");
		if (!config.documentation?.enabled) {
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "text/plain",
						text: "Error: No resource handler found for URI: scope-documentation",
					},
				],
			};
		}
		return getScopeDocumentation("default");
	});

	server.registerResource("collection-documentation", "collection-documentation://", {}, async (uri: URL) => {
		logger.info({ uri: uri.href }, "Handling collection documentation request");
		if (!config.documentation?.enabled) {
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "text/plain",
						text: "Error: No resource handler found for URI: collection-documentation",
					},
				],
			};
		}
		return getCollectionDocumentation("default", "default");
	});

	server.registerResource("documentation-file", "documentation-file://", {}, async (uri: URL) => {
		logger.info({ uri: uri.href }, "Handling documentation file request");
		if (!config.documentation?.enabled) {
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "text/plain",
						text: "Error: No resource handler found for URI: documentation-file",
					},
				],
			};
		}
		return getDocumentationFile("default", "default", "default");
	});

	// --- Dynamic resources (ResourceTemplate) ---

	// Ported verbatim from documentResource.ts.
	const documentTemplate = new ResourceTemplate("document://{scope}/{collection}/{id}", { list: undefined });
	server.registerResource("document", documentTemplate, {}, async (uri: URL, variables) => {
		const scopeName = String(variables.scope ?? "");
		const collectionName = String(variables.collection ?? "");
		const docId = String(variables.id ?? "");
		try {
			logger.info({ scope: scopeName, collection: collectionName, id: docId }, "Fetching document resource");
			const bucket = await connectionManager.getConnection();

			try {
				const doc = await bucket.scope(scopeName).collection(collectionName).get(docId);
				return ResponseBuilder.success(doc.content as DocumentContent, "json").buildResourceResponse(uri.href);
			} catch (error) {
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
	});

	// Ported verbatim from queryResource.ts.
	const queryTemplate = new ResourceTemplate("query://{scope}/{encodedQuery}", { list: undefined });
	server.registerResource("query-results", queryTemplate, {}, async (uri: URL, variables) => {
		const scopeName = String(variables.scope ?? "");
		const encodedQueryStr = String(variables.encodedQuery ?? "");
		try {
			const query = decodeURIComponent(encodedQueryStr);
			logger.info({ scope: scopeName, query }, "Executing query resource");
			const bucket = await connectionManager.getConnection();

			try {
				const scopes = await bucket.collections().getAllScopes();
				const foundScope = scopes.find((s) => s.name === scopeName);

				if (!foundScope) {
					return ResponseBuilder.error(`Scope not found: ${scopeName}`).buildResourceResponse(uri.href);
				}

				const upperQuery = query.trim().toUpperCase();
				if (!upperQuery.startsWith("SELECT")) {
					return ResponseBuilder.error("Only SELECT queries are allowed via the query resource").buildResourceResponse(
						uri.href,
					);
				}

				let safeQuery = query;
				if (!upperQuery.includes("LIMIT")) {
					safeQuery = `${query} LIMIT 100`;
				}

				const parsedQuery = sqlppParser.parse(safeQuery);
				if (sqlppParser.modifiesData(parsedQuery) || sqlppParser.modifiesStructure(parsedQuery)) {
					return ResponseBuilder.error(
						"Modification queries are not allowed via the query resource",
					).buildResourceResponse(uri.href);
				}

				const result = await bucket.scope(scopeName).query(safeQuery);
				const rows = await result.rows;

				return ResponseBuilder.success(rows, "json").buildResourceResponse(uri.href);
			} catch (queryError) {
				if (queryError instanceof Error) {
					return ResponseBuilder.error("Query execution failed", queryError).buildResourceResponse(uri.href);
				}
				throw queryError;
			}
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					scope: scopeName,
					encodedQuery: encodedQueryStr,
				},
				"Error executing query resource",
			);

			return ResponseBuilder.error(
				"Error executing query",
				error instanceof Error ? error : new Error(String(error)),
			).buildResourceResponse(uri.href);
		}
	});

	// Ported verbatim from schemaResource.ts.
	const schemaTemplate = new ResourceTemplate("schema://{scope}/{collection}", { list: undefined });
	server.registerResource("collection-schema", schemaTemplate, {}, async (uri: URL, variables) => {
		const scopeName = String(variables.scope ?? "");
		const collectionName = String(variables.collection ?? "");
		try {
			logger.info({ scope: scopeName, collection: collectionName }, "Fetching schema resource");
			const bucket = await connectionManager.getConnection();

			const collectionMgr = bucket.collections();
			const scopes = await collectionMgr.getAllScopes();
			const foundScope = scopes.find((s) => s.name === scopeName);

			if (!foundScope) {
				return ResponseBuilder.error(`Scope "${scopeName}" not found`).buildResourceResponse(uri.href);
			}

			const foundCollection = foundScope.collections.find((c) => c.name === collectionName);
			if (!foundCollection) {
				return ResponseBuilder.error(
					`Collection "${collectionName}" not found in scope "${scopeName}"`,
				).buildResourceResponse(uri.href);
			}

			try {
				const result = await bucket
					.scope(scopeName)
					.query(`SELECT RAW META().id FROM \`${bucket.name}\`.\`${scopeName}\`.\`${collectionName}\` LIMIT 1`);

				const rows = await result.rows;

				if (rows && rows.length > 0) {
					const docId = rows[0];
					const docResult = await bucket.scope(scopeName).collection(collectionName).get(docId);

					const schemaText = formatDocumentAsSchema(docResult.content);
					return ResponseBuilder.markdown(schemaText).buildResourceResponse(uri.href);
				}
				return ResponseBuilder.error(
					`No documents found in ${scopeName}.${collectionName} to infer schema.`,
				).buildResourceResponse(uri.href);
			} catch (queryError) {
				if (isNoIndexError(queryError)) {
					return ResponseBuilder.error(
						`Unable to query collection. You may need to create a primary index:\nCREATE PRIMARY INDEX ON \`${bucket.name}\`.\`${scopeName}\`.\`${collectionName}\`;`,
					).buildResourceResponse(uri.href);
				}
				throw queryError;
			}
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error), scope: scopeName, collection: collectionName },
				"Error fetching schema resource",
			);

			return ResponseBuilder.error(
				"Error fetching schema resource",
				error instanceof Error ? error : new Error(String(error)),
			).buildResourceResponse(uri.href);
		}
	});

	// --- Playbook resources (config.playbooks.enabled + directory-fallback search gated) ---

	// SIO-1443: mirrors v1's registerPlaybookResources no-op when loadPlaybooks() returns null
	// (playbooks.enabled === false, OR enabled === true but no fallback directory has a matching
	// markdown file) -- registerAllResources never registers ANY playbook resource in that case, so
	// a v1 playbook:// read falls through to "No resource handler found for URI". v2 mirrors this by
	// simply not calling registerResource at all when the registry resolves to null, rather than
	// registering a gate-checking handler (unlike the docs:// resources above, which must register
	// unconditionally to keep a single, static call-site shape) -- this is possible here because the
	// resource list itself is only known after the async probe completes.
	const playbookRegistry = await loadPlaybookRegistry();
	if (playbookRegistry) {
		const { baseDirectory, playbookFiles } = playbookRegistry;
		const fileExtension = config.playbooks.fileExtension || ".md";

		server.registerResource("playbook-directory", "playbook://", {}, async (uri: URL) => {
			logger.info({ uri: uri.href }, "Handling direct resource request for playbook-directory");
			return listPlaybooks(baseDirectory, playbookFiles);
		});

		for (const file of playbookFiles) {
			const resourceId = file.replace(new RegExp(`\\${fileExtension}$`), "");
			const resourceUri = `playbook://${resourceId}`;

			server.registerResource(`playbook-${resourceId}`, resourceUri, {}, async (uri: URL) => {
				logger.info({ uri: uri.href }, `Handling direct resource request for playbook: ${resourceId}`);
				return getPlaybook(baseDirectory, fileExtension, playbookFiles, resourceId);
			});
		}
	}

	logger.info("v2 resources registered successfully");
}
