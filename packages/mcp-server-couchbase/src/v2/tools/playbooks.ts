// src/v2/tools/playbooks.ts
//
// SIO-1443: v2 port of the 2 playbook tools (list/get markdown playbooks under
// config.playbooks.baseDirectory). Re-implemented against @modelcontextprotocol/server's
// registerTool config style -- v1's tool file (packages/mcp-server-couchbase/src/tools/listPlaybooks.ts)
// imports McpServer from @modelcontextprotocol/sdk, a different package, so it is read as reference
// only, not imported. Handler bodies are ported verbatim; only the server/registration plumbing
// changes. Annotations are hand-written per tool below (see tool-classification.ts's
// READ_ONLY_TOOLS/WRITE_TOOLS/DESTRUCTIVE_TOOLS for the source of truth) since
// couchbaseToolAnnotations() itself is v1-only (imports ToolAnnotations from the v1 SDK's types
// module).
//
// v1's tools dispatch through server.readResourceByUri's playbook:// fast path
// (buildReadResourceByUri in server.ts), which only fires "if (protocol === 'playbook' &&
// ds.playbooks)" -- ds.playbooks is the PlaybookRegistry produced by loadPlaybooks() in
// playbookResource.ts, which returns null whenever config.playbooks.enabled is false (the
// SIO-1177 default) OR no directory with matching markdown files is found. When ds.playbooks is
// null, v1 falls through to the generic ResourceRegistry, which also has nothing registered for
// playbook:// (registerPlaybookResources no-ops on a null registry) and throws
// "No resource handler found for URI: playbook://...". v2 has no resource registry or boot-time
// directory scan to mirror that lazily-built PlaybookRegistry, so this port re-scans the
// playbooks directory synchronously per call (scoped to exactly the two shapes
// PlaybookHandler.listPlaybooks/getPlaybook produce) and gates on config.playbooks.enabled the
// same way documentation.ts gates on config.documentation.enabled -- see that file's header
// comment for the precedent this follows.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer, RegisteredTool, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "../../config";
import { createError } from "../../lib/errors";
import { logger } from "../../utils/logger";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };

interface PlaybookResourceContent {
	contents?: Array<{ mimeType?: string; text?: string }>;
}

// Ported from playbookResource.ts's loadPlaybooks -- v1's PlaybookRegistry is null under TWO
// independent conditions: config.playbooks.enabled === false (handled by the caller's own gate),
// OR enabled === true but none of the 3 fallback directories has a matching markdown file. Both
// conditions produce the SAME "No resource handler found for URI: playbook://" error in v1's
// buildReadResourceByUri fast path. Without reproducing this directory probe, a v2 call with
// enabled=true but a missing/empty baseDirectory would fall through to listPlaybooksContent's own
// fs.readdir(), which throws ENOENT and gets caught into a 200 success result with raw filesystem
// path text -- a materially different (and leakier) failure signal than v1's.
async function resolvePlaybookDirectory(): Promise<string | null> {
	const packageRoot = path.resolve(import.meta.dir, "../../..");
	const possibleDirs = [
		config.playbooks?.baseDirectory,
		path.join(process.cwd(), "playbook"),
		path.join(import.meta.dir, "../../../playbook"),
		path.join(packageRoot, "playbook"),
	].filter((dir): dir is string => !!dir);

	const fileExtension = config.playbooks.fileExtension || ".md";

	for (const dir of possibleDirs) {
		try {
			await fs.access(dir);
			const files = await fs.readdir(dir);
			if (files.some((file) => file.endsWith(fileExtension))) {
				return dir;
			}
		} catch (_err) {
			// Directory not accessible -- try the next fallback, same as loadPlaybooks.
		}
	}

	return null;
}

// Ported from playbookResource.ts's PlaybookHandler.listPlaybooks -- builds a markdown listing of
// every playbook file in baseDirectory, using each file's first line (stripped of a leading "#
// ") as its description.
async function listPlaybooksContent(baseDirectory: string, fileExtension: string): Promise<PlaybookResourceContent> {
	try {
		const files = await fs.readdir(baseDirectory);
		const playbookFiles = files.filter((file) => file.endsWith(fileExtension));

		let text = "# Available Playbooks\n\n";

		for (const file of playbookFiles) {
			const resourceId = file.replace(new RegExp(`\\${fileExtension}$`), "");
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

		return { contents: [{ mimeType: "text/markdown", text }] };
	} catch (error) {
		logger.error({ error: error instanceof Error ? error.message : String(error) }, "Error listing playbooks");
		return {
			contents: [
				{
					mimeType: "text/plain",
					text: `Error listing playbooks: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
}

// Ported from playbookResource.ts's PlaybookHandler.getPlaybook -- reads a single playbook file
// by id, verifying it exists in the directory listing before reading it.
async function getPlaybookContent(
	baseDirectory: string,
	fileExtension: string,
	playbookId: string,
): Promise<PlaybookResourceContent> {
	try {
		if (!playbookId || playbookId === "undefined") {
			logger.warn(`Invalid playbook ID: ${playbookId}`);
			return { contents: [{ mimeType: "text/plain", text: "Error: Invalid playbook ID" }] };
		}

		const fileName = `${playbookId}${fileExtension}`;
		const filePath = path.join(baseDirectory, fileName);

		const files = await fs.readdir(baseDirectory);
		if (!files.includes(fileName)) {
			logger.warn(`Playbook not found: ${playbookId}`);
			return { contents: [{ mimeType: "text/plain", text: `Error: Playbook "${playbookId}" not found` }] };
		}

		const text = await fs.readFile(filePath, "utf-8");
		return { contents: [{ mimeType: "text/markdown", text }] };
	} catch (error) {
		logger.error(
			{ error: error instanceof Error ? error.message : String(error) },
			`Error reading playbook: ${playbookId}`,
		);
		return {
			contents: [
				{
					mimeType: "text/plain",
					text: `Error reading playbook: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
}

export function registerPlaybookToolsV2(server: McpServer, tools: Map<string, RegisteredTool>): void {
	const listPlaybooks = server.registerTool(
		"capella_list_playbooks",
		{
			description: "List all available playbooks",
			inputSchema: z.object({}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async () => {
			// SIO-1443: mirrors v1's playbook:// fast path guard (ds.playbooks is null whenever
			// config.playbooks.enabled is false, the SIO-1177 default) -- without this check this
			// tool would list real playbooks (or a real "no directory" error) where v1 throws "No
			// resource handler found for URI: playbook://" instead.
			if (!config.playbooks.enabled) {
				throw createError("NOT_FOUND", "No resource handler found for URI: playbook://");
			}

			// SIO-1443 follow-up: v1's PlaybookRegistry is also null when enabled=true but none of
			// loadPlaybooks's 3 fallback directories has a matching markdown file -- that produces
			// the SAME clean error in v1, so mirror it here instead of letting listPlaybooksContent's
			// own fs.readdir() throw ENOENT into a 200 success result with a leaked filesystem path.
			const playbookDir = await resolvePlaybookDirectory();
			if (!playbookDir) {
				throw createError("NOT_FOUND", "No resource handler found for URI: playbook://");
			}

			try {
				logger.info("Listing available playbooks");

				const resourceResult = await listPlaybooksContent(playbookDir, config.playbooks.fileExtension || ".md");

				if (!resourceResult?.contents?.length) {
					return { content: [{ type: "text" as const, text: "No playbooks found" }] };
				}

				return {
					content: resourceResult.contents.map((content) => ({
						type: "text" as const,
						text: content.text || "[Binary content]",
					})),
				};
			} catch (error) {
				logger.error({ error: error instanceof Error ? error.message : String(error) }, "Error in list_playbooks tool");

				return {
					content: [
						{
							type: "text" as const,
							text: `Error listing playbooks: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);
	tools.set("capella_list_playbooks", listPlaybooks);

	const getPlaybook = server.registerTool(
		"capella_get_playbook",
		{
			description: "Get a specific playbook by ID",
			inputSchema: z.object({
				playbook_id: z.string().describe("ID of the playbook to retrieve"),
			}),
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async ({ playbook_id }) => {
			// SIO-1443: same gate as capella_list_playbooks above.
			if (!config.playbooks.enabled) {
				throw createError("NOT_FOUND", `No resource handler found for URI: playbook://${playbook_id}`);
			}

			// SIO-1443 follow-up: same fallback-directory parity as capella_list_playbooks above.
			const playbookDir = await resolvePlaybookDirectory();
			if (!playbookDir) {
				throw createError("NOT_FOUND", `No resource handler found for URI: playbook://${playbook_id}`);
			}

			try {
				logger.info({ playbook_id }, "Getting playbook");

				const resourceResult = await getPlaybookContent(
					playbookDir,
					config.playbooks.fileExtension || ".md",
					playbook_id,
				);

				if (!resourceResult?.contents?.length) {
					return { content: [{ type: "text" as const, text: `Playbook not found: ${playbook_id}` }] };
				}

				return {
					content: resourceResult.contents.map((content) => ({
						type: "text" as const,
						text: content.text || "[Binary content]",
					})),
				};
			} catch (error) {
				logger.error(
					{ error: error instanceof Error ? error.message : String(error), playbook_id },
					"Error in get_playbook tool",
				);

				return {
					content: [
						{
							type: "text" as const,
							text: `Error retrieving playbook: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);
	tools.set("capella_get_playbook", getPlaybook);
}
