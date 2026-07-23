/* src/resources/playbookResource.ts */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config";
import { logger } from "../utils/logger";

/**
 * Playbook handler class that manages access to playbook content
 */
export class PlaybookHandler {
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
				logger.warn(`Invalid playbook ID: ${playbookId}`);
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

// SIO-1044: pre-enumerated playbook state, produced once by loadPlaybooks (async, fs-bound) in
// initDatasource and consumed synchronously by registerPlaybookResources on every factory replay.
export interface PlaybookRegistry {
	handler: PlaybookHandler;
	resourceIds: string[];
}

/**
 * Async directory probing + handler initialization for the playbook feature. Runs ONCE, in
 * initDatasource -- never inside registerAll (which must stay synchronous for the cached server
 * factory). Returns null when playbooks are disabled in config or no directory with markdown
 * files could be found.
 */
export async function loadPlaybooks(): Promise<PlaybookRegistry | null> {
	if (!config.playbooks?.enabled) {
		logger.info("Playbook resources are disabled in config");
		return null;
	}

	try {
		// Find the playbook directory from possible locations. The first three are
		// cwd/-dist-relative and miss when the process launches from the monorepo
		// root, so also probe the package root itself (source layout: src/resources/
		// -> two levels up).
		const packageRoot = path.resolve(import.meta.dir, "../..");
		const possibleDirs = [
			config.playbooks?.baseDirectory,
			path.join(process.cwd(), "playbook"),
			path.join(__dirname, "../../playbook"),
			path.join(packageRoot, "playbook"),
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
			// Expected configuration state (no playbooks shipped), not a fault -- warn, not error.
			logger.warn("No playbook directory found with markdown files; playbook resources disabled");
			return null;
		}

		// Initialize the playbook handler
		const handler = new PlaybookHandler(playbookDir, config.playbooks.fileExtension);
		await handler.initialize();

		const playbooks = await fs.readdir(playbookDir);
		const playbookFiles = playbooks.filter((file) => file.endsWith(config.playbooks.fileExtension || ".md"));
		const resourceIds = playbookFiles.map((file) =>
			file.replace(new RegExp(`\\${config.playbooks.fileExtension || ".md"}$`), ""),
		);

		return { handler, resourceIds };
	} catch (err) {
		logger.error(
			{
				error: err instanceof Error ? err.message : String(err),
			},
			"Error loading playbook resources",
		);
		return null;
	}
}

/**
 * Register playbook resources from a pre-enumerated PlaybookRegistry.
 * Makes playbooks available via resources/list and resources/read endpoints.
 * Sync -- safe to call from registerAll under the cached server factory. No-op when playbooks
 * is null (disabled / no directory found).
 *
 * SIO-1044: the generic readResourceByUri assignment previously lived here (racing against an
 * equivalent assignment in server.ts, decided nondeterministically by microtask ordering under
 * the old floating-promise registerAllResources call). It has been removed -- server.ts's
 * assignment is now the sole, canonical implementation.
 */
export function registerPlaybookResources(server: McpServer, playbooks: PlaybookRegistry | null): void {
	if (!playbooks) {
		return;
	}
	const { handler, resourceIds } = playbooks;

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
	for (const resourceId of resourceIds) {
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

	logger.info("Playbook resources registered successfully");
}
