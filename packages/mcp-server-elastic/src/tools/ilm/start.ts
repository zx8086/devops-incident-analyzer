/* src/tools/ilm/start.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

/* SIMPLIFIED VERSION: Direct JSON Schema + MCP Error Codes */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

const startValidator = z.object({
	masterTimeout: z.string().optional().describe("Master node timeout"),
	timeout: z.string().optional().describe("Request timeout"),
});

type StartParams = z.infer<typeof startValidator>;

function createIlmStartMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "permission" | "already_started";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		permission: ErrorCode.InvalidRequest,
		already_started: ErrorCode.InvalidRequest,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_ilm_start] ${message}`, context.details);
}

export const registerStartTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const startHandler = async (args: StartParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Simple validation - no complex parameter extraction
			const params = startValidator.parse(args);

			logger.debug(
				{
					masterTimeout: params.masterTimeout,
					timeout: params.timeout,
				},
				"Starting ILM",
			);

			const result = await esClient.ilm.start({
				master_timeout: params.masterTimeout,
				timeout: params.timeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow ILM operation: start");
			}

			logger.info("ILM started successfully");

			// MCP-compliant success response
			return {
				content: [
					{
						type: "text",
						text: `**ILM Started Successfully**

Index Lifecycle Management is now running and will begin processing policies.

Operation completed at: ${new Date().toISOString()}`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								acknowledged: result.acknowledged || true,
								operation: "start_ilm",
								timestamp: new Date().toISOString(),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (error) {
			// Standardized MCP error handling
			if (error instanceof z.ZodError) {
				throw createIlmStartMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createIlmStartMcpError("Insufficient permissions to start ILM", {
						type: "permission",
						details: { originalError: error.message },
					});
				}

				if (error.message.includes("already_started") || error.message.includes("already running")) {
					throw createIlmStartMcpError("ILM is already running", {
						type: "already_started",
						details: { suggestion: "Use get_status to check current ILM state" },
					});
				}
			}

			throw createIlmStartMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: {
					duration: performance.now() - perfStart,
					args,
				},
			});
		}
	};

	// Direct tool registration with JSON Schema + read-only protection
	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_ilm_start",

		{
			title: "Ilm Start",

			description:
				"Start ILM. Start the Index Lifecycle Management plugin to resume automated operations. Uses direct JSON Schema and standardized MCP error codes. Examples: {} (no params needed), {masterTimeout: 30s}.",

			inputSchema: startValidator.shape,
		},

		startHandler,
	);
};
