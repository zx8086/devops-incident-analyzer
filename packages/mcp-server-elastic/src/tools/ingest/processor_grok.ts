// tools/ingest/processor_grok.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, TextContent, ToolRegistrationFunction } from "../types.js";

const processorGrokValidator = z.object({
	filter: z.string().optional(),
});

export const registerProcessorGrokTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: any): Promise<SearchResult> => {
		const perfStart = performance.now();
		const requestId = Math.random().toString(36).substring(7);

		try {
			const params = processorGrokValidator.parse(args);

			logger.info({ filter: params.filter }, `[${requestId}] Getting built-in grok patterns`);

			const result = await esClient.ingest.processorGrok({}, { opaqueId: "elasticsearch_processor_grok" });

			let patterns = result.patterns ?? {};

			// Filter patterns if a filter string is provided
			if (params.filter) {
				const filterLower = params.filter.toLowerCase();
				patterns = Object.fromEntries(
					Object.entries(patterns).filter(
						([name, pattern]) =>
							name.toLowerCase().includes(filterLower) ||
							(typeof pattern === "string" && pattern.toLowerCase().includes(filterLower)),
					),
				);
			}

			const patternCount = Object.keys(patterns).length;
			logger.info({ patternCount, filtered: !!params.filter }, `[${requestId}] Retrieved grok patterns`);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, requestId }, "Slow grok patterns retrieval");
			}

			return {
				content: [{ type: "text", text: JSON.stringify(patterns, null, 2) } as TextContent],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw new McpError(
					ErrorCode.InvalidParams,
					`[elasticsearch_processor_grok] Validation failed: ${error.issues.map((e) => e.message).join(", ")}`,
				);
			}

			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				},
				`[${requestId}] Failed to get grok patterns`,
			);

			throw new McpError(
				ErrorCode.InternalError,
				`[elasticsearch_processor_grok] ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	server.registerTool(
		"elasticsearch_processor_grok",
		{
			title: "Get Grok Patterns",
			description:
				"Get built-in grok patterns available for use in ingest pipeline grok processors. Use {filter} to search for patterns by name or content (e.g., filter: 'SYSLOG' to find syslog-related patterns). Useful for debugging grok failures by verifying which patterns exist. READ operation - safe for production use.",
			inputSchema: {
				filter: z.string().optional(), // Filter patterns by name or content substring (case-insensitive). E.g., 'SYSLOG', 'IP', 'TIMESTAMP'.
			},
		},
		handler,
	);
};
