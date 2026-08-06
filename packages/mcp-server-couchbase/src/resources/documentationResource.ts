/* src/resources/documentationResource.ts */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { createError } from "../lib/errors";
import { logger } from "../utils/logger";
import type { ResourceRegistry } from "./resource-registry";

/**
 * Configuration for the markdown documentation resource
 */
interface MarkdownDocsConfig {
	/**
	 * Base directory for the documentation files
	 */
	baseDirectory: string;

	/**
	 * Default extension for documentation files (e.g., .md)
	 */
	fileExtension: string;
}

/**
 * Documentation handler class that manages access to documentation content.
 * Exported for the docs:// fast path in server.ts's readResourceByUri (SIO-1052): the SDK-registered
 * docs resources only cover the exact root URI, so scoped lookups dispatch straight to this handler.
 */
export class DocumentationHandler {
	baseDirectory: string;
	fileExtension: string;

	constructor(config: MarkdownDocsConfig) {
		this.baseDirectory = config.baseDirectory;
		this.fileExtension = config.fileExtension || ".md";
	}

	// Function to sanitize file paths to prevent directory traversal
	private sanitizePath(inputPath: string): string {
		return path.normalize(inputPath).replace(/^(\.\.(\/|\\|$))+/, "");
	}

	/**
	 * List all available documentation at the root level
	 */
	async listDocumentation() {
		try {
			// List all scopes
			const dirEntries = await fs.readdir(this.baseDirectory, { withFileTypes: true });
			const scopes = dirEntries.filter((entry) => entry.isDirectory()).map((dir) => dir.name);

			let documentationText = "# Documentation Browser\n\n";
			documentationText += "Browse documentation for database scopes and collections.\n\n";

			if (scopes.length > 0) {
				documentationText += "## Available Scopes\n\n";

				for (const scope of scopes) {
					documentationText += `- ${scope}\n`;

					// Try to list collections in this scope
					try {
						const scopePath = path.join(this.baseDirectory, this.sanitizePath(scope));
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
				{
					error: error instanceof Error ? error.message : String(error),
				},
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

	/**
	 * Get scope-level documentation
	 */
	async getScopeDocumentation(scope: string) {
		try {
			logger.info(`Getting scope documentation for ${scope}`);
			const documentationText = `# Scope Documentation\n\nThis is a placeholder for documentation about the ${scope} scope.\n\nThe detailed scope documentation is not yet available.`;

			return {
				contents: [
					{
						uri: `docs://${scope}`,
						mimeType: "text/markdown",
						text: documentationText,
					},
				],
			};
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					scope,
				},
				"Error fetching scope documentation",
			);

			return {
				contents: [
					{
						uri: `docs://${scope}`,
						mimeType: "text/plain",
						text: `Error fetching documentation: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
			};
		}
	}

	/**
	 * Get collection-level documentation
	 */
	async getCollectionDocumentation(scope: string, collection: string) {
		try {
			logger.info(`Getting collection documentation for ${scope}/${collection}`);
			const documentationText = `# Collection Documentation\n\nThis is a placeholder for documentation about the ${collection} collection in the ${scope} scope.\n\nThe detailed collection documentation is not yet available.`;

			return {
				contents: [
					{
						uri: `docs://${scope}/${collection}`,
						mimeType: "text/markdown",
						text: documentationText,
					},
				],
			};
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					scope,
					collection,
				},
				"Error fetching collection documentation",
			);

			return {
				contents: [
					{
						uri: `docs://${scope}/${collection}`,
						mimeType: "text/plain",
						text: `Error fetching documentation: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
			};
		}
	}

	/**
	 * Get specific documentation file
	 */
	async getDocumentationFile(scope: string, collection: string, file: string) {
		try {
			logger.info(`Getting documentation file ${scope}/${collection}/${file}`);
			const documentationText = `# Documentation File\n\nThis is a placeholder for the documentation file ${file} in the ${collection} collection of the ${scope} scope.\n\nThe detailed file documentation is not yet available.`;

			return {
				contents: [
					{
						uri: `docs://${scope}/${collection}/${file}`,
						mimeType: "text/markdown",
						text: documentationText,
					},
				],
			};
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					scope,
					collection,
					file,
				},
				"Error fetching documentation file",
			);

			return {
				contents: [
					{
						uri: `docs://${scope}/${collection}/${file}`,
						mimeType: "text/plain",
						text: `Error fetching documentation: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
			};
		}
	}
}

/**
 * Registers a resource for serving markdown documentation files
 * that match the database's scope and collection structure
 */
export function registerMarkdownDocumentationResource(
	server: McpServer,
	_bucket: Bucket,
	config: MarkdownDocsConfig,
	registry: ResourceRegistry,
): DocumentationHandler {
	// Validate config
	if (!config.baseDirectory) {
		throw createError("CONFIG_ERROR", "baseDirectory is required for markdown documentation resource");
	}

	// Create handler instance
	const handler = new DocumentationHandler(config);

	// SIO-1412: each handler const is registered on the SDK server AND in couchbase's
	// own registry, so readResourceByUri dispatches without SDK-internal reach-in.
	// Register the documentation-browser resource
	logger.info("Registering documentation-browser resource");
	const readDocumentationBrowser = async (uri: URL) => {
		logger.info({ uri: uri.href }, "Handling documentation browser request");
		return handler.listDocumentation();
	};
	server.resource("documentation-browser", "docs://", readDocumentationBrowser);
	registry.addExact("docs://", readDocumentationBrowser);

	// Register scope-documentation resource with a placeholder implementation
	logger.info("Registering scope-documentation resource");
	const readScopeDocumentation = async (uri: URL) => {
		// This is a placeholder implementation that doesn't rely on URI parameters
		logger.info({ uri: uri.href }, "Handling scope documentation request");
		return handler.getScopeDocumentation("default");
	};
	// "scope-documentation" is a simple URI to avoid template issues
	server.resource("scope-documentation", "scope-documentation", readScopeDocumentation);
	registry.addExact("scope-documentation", readScopeDocumentation);

	// Register collection-documentation resource with a placeholder implementation
	logger.info("Registering collection-documentation resource");
	const readCollectionDocumentation = async (uri: URL) => {
		// This is a placeholder implementation that doesn't rely on URI parameters
		logger.info({ uri: uri.href }, "Handling collection documentation request");
		return handler.getCollectionDocumentation("default", "default");
	};
	server.resource("collection-documentation", "collection-documentation", readCollectionDocumentation);
	registry.addExact("collection-documentation", readCollectionDocumentation);

	// Register documentation-file resource with a placeholder implementation
	logger.info("Registering documentation-file resource");
	const readDocumentationFile = async (uri: URL) => {
		// This is a placeholder implementation that doesn't rely on URI parameters
		logger.info({ uri: uri.href }, "Handling documentation file request");
		return handler.getDocumentationFile("default", "default", "default");
	};
	server.resource("documentation-file", "documentation-file", readDocumentationFile);
	registry.addExact("documentation-file", readDocumentationFile);

	// SIO-1052: the old "custom handler for resources/templates/list" block here was dead code --
	// McpServer has no own setRequestHandler, so it always fell through to a no-op (same verified
	// pattern removed from playbookResource.ts in SIO-1044); the SDK registers its own real
	// resources/templates/list handler.

	logger.info(
		{
			baseDirectory: config.baseDirectory,
			fileExtension: config.fileExtension,
		},
		"Markdown documentation resources registered successfully",
	);

	return handler;
}
