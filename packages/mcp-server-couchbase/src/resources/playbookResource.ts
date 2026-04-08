/* src/resources/playbookResource.ts */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config";
import { logger } from "../utils/logger";

/**
 * Playbook handler class that manages access to playbook content
 */
class PlaybookHandler {
	baseDirectory: string;
	fileExtension: string;
	playbookFiles: string[] = [];

	constructor(baseDir?: string, fileExt?: string) {
		this.baseDirectory = baseDir || config.playbooks?.baseDirectory || "./playbook";
		this.fileExtension = fileExt || config.playbooks?.fileExtension || ".md";
	}

	/**
	 * Initialize by scanning the directory for playbooks
	 */
	async initialize(): Promise<void> {
		try {
			const files = await fs.readdir(this.baseDirectory);
			this.playbookFiles = files.filter((file) => file.endsWith(this.fileExtension));
			logger.info(`Found ${this.playbookFiles.length} playbooks in directory`);
		} catch (err) {
			logger.error({ error: err }, `Error reading playbook directory: ${this.baseDirectory}`);
			this.playbookFiles = [];
		}
	}

	/**
	 * List all available playbooks
	 */
	async listPlaybooks() {
		try {
			// Build markdown listing for human users
			let text = "# Available Playbooks\n\n";

			for (const file of this.playbookFiles) {
				const resourceId = file.replace(new RegExp(`\\${this.fileExtension}$`), "");
				const filePath = path.join(this.baseDirectory, file);
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

	/**
	 * Get a specific playbook by ID
	 */
	async getPlaybook(playbookId: string) {
		try {
			if (!playbookId || playbookId === "undefined") {
				logger.error(`Invalid playbook ID: ${playbookId}`);
				return {
					contents: [
						{
							uri: `playbook://${playbookId}`,
							mimeType: "text/plain",
							text: `Error: Invalid playbook ID`,
						},
					],
				};
			}

			const fileName = `${playbookId}${this.fileExtension}`;
			const filePath = path.join(this.baseDirectory, fileName);

			// Verify this is an allowed playbook file
			if (!this.playbookFiles.includes(fileName)) {
				logger.error(`Playbook not found: ${playbookId}`);
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

			// Read and return the playbook content
			const text = await fs.readFile(filePath, "utf-8");
			return {
				contents: [
					{
						uri: `playbook://${playbookId}`,
						mimeType: "text/markdown",
						text,
					},
				],
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
}

/**
 * Register playbook resources from the playbook directory
 * Makes playbooks available via resources/list and resources/read endpoints
 */
export async function registerPlaybookResources(server: McpServer): Promise<void> {
	if (!config.playbooks?.enabled) {
		logger.info("Playbook resources are disabled in config");
		return;
	}

	try {
		// Find the playbook directory from possible locations
		const possibleDirs = [
			config.playbooks?.baseDirectory,
			path.join(process.cwd(), "playbook"),
			path.join(__dirname, "../../playbook"),
		].filter((dir): dir is string => !!dir);

		logger.debug({ possibleDirs }, "Checking possible playbook directories");

		let playbookDir: string | null = null;

		for (const dir of possibleDirs) {
			try {
				await fs.access(dir);
				const files = await fs.readdir(dir);
				const mdFiles = files.filter((file) => file.endsWith(config.playbooks.fileExtension || ".md"));
				if (mdFiles.length > 0) {
					playbookDir = dir;
					logger.info({ count: mdFiles.length }, `Found playbooks in ${dir}`);
					break;
				}
			} catch (err) {
				logger.debug(
					{
						error: err instanceof Error ? err.message : String(err),
					},
					`Directory not accessible: ${dir}`,
				);
			}
		}

		if (!playbookDir) {
			logger.error("No playbook directory found with markdown files");
			return;
		}

		// Initialize the playbook handler
		const handler = new PlaybookHandler(playbookDir, config.playbooks.fileExtension);
		await handler.initialize();

		// Register resources - both for resources/list and resources/read
		// First register with the original method that works with resources/read
		server.resource(
			"playbook-directory", // Resource ID
			"playbook://", // URI
			async (uri) => {
				logger.info({ uri: uri.href }, "Handling direct resource request for playbook-directory");
				return handler.listPlaybooks();
			},
		);

		// Also register specific handlers for individual playbooks
		const playbooks = await fs.readdir(playbookDir);
		const playbookFiles = playbooks.filter((file) => file.endsWith(config.playbooks.fileExtension || ".md"));

		for (const file of playbookFiles) {
			const resourceId = file.replace(new RegExp(`\\${config.playbooks.fileExtension || ".md"}$`), "");
			const resourceUri = `playbook://${resourceId}`;

			// Register each playbook as a separate resource
			server.resource(
				`playbook-${resourceId}`, // Resource ID
				resourceUri, // URI
				async (uri) => {
					logger.info({ uri: uri.href }, `Handling direct resource request for playbook: ${resourceId}`);
					return handler.getPlaybook(resourceId);
				},
			);
		}

		// Expose a method for tools to easily access resources by URI
		(server as Record<string, unknown>).readResourceByUri = (async (resourceUri: string) => {
			try {
				logger.info(`Handling readResourceByUri for: ${resourceUri}`);
				// Simple URL parsing without using URL constructor (for compatibility)
				const protocol = resourceUri.split("://")[0];
				const path = resourceUri.split("://")[1] || "";

				if (protocol === "playbook") {
					if (path === "") {
						return handler.listPlaybooks();
					} else {
						return handler.getPlaybook(path);
					}
				}

				// Look through server resources for a matching URI
				const serverInternal = server as Record<string, unknown>;
				interface ResourceEntry {
					uri?: string;
					handler: (href: { href: string }, params: Record<string, unknown>) => Promise<unknown>;
				}
				const resourceMap = serverInternal._resources || serverInternal.resources || new Map();
				if (resourceMap instanceof Map) {
					for (const [id, resource] of resourceMap.entries() as IterableIterator<[string, ResourceEntry]>) {
						if (resource.uri === resourceUri) {
							logger.info(`Found matching resource for ${resourceUri}: ${id}`);
							return resource.handler({ href: resourceUri }, {});
						}
					}
				} else if (typeof resourceMap === "object" && resourceMap !== null) {
					for (const id in resourceMap as Record<string, ResourceEntry>) {
						const resource = (resourceMap as Record<string, ResourceEntry>)[id];
						if (resource.uri === resourceUri) {
							logger.info(`Found matching resource for ${resourceUri}: ${id}`);
							return resource.handler({ href: resourceUri }, {});
						}
					}
				}

				throw new Error(`No resource handler found for URI: ${resourceUri}`);
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : String(error),
					},
					`Error reading resource URI: ${resourceUri}`,
				);
				throw error;
			}
		}).bind(server);

		// Work around the template issue by adding a custom handler for templates listing
		const serverExt = server as Record<string, unknown>;
		type RequestHandler = (schema: { method: string }, handler: () => Promise<unknown>) => void;
		(serverExt as Record<string, RequestHandler | (() => void)>).setRequestHandler =
			(serverExt as Record<string, RequestHandler | undefined>).setRequestHandler || (() => {});
		const setHandler = (serverExt as Record<string, RequestHandler>).setRequestHandler;
		setHandler(
			{
				method: "resources/templates/list",
			},
			async () => {
				logger.info("Custom handler for resources/templates/list called");
				// Return an empty but properly structured templates array
				return { templates: [] };
			},
		);

		// Also handle resources/list to include our resources
		setHandler(
			{
				method: "resources/list",
			},
			async () => {
				logger.info("Custom handler for resources/list called");
				return {
					resources: [
						{
							id: "playbook-directory",
							uri: "playbook://",
							name: "Playbook Directory",
							description: "Directory of available playbooks",
						},
					],
				};
			},
		);

		logger.info("Playbook resources registered successfully");
	} catch (err) {
		logger.error(
			{
				error: err instanceof Error ? err.message : String(err),
			},
			"Error registering playbook resources",
		);
	}
}
