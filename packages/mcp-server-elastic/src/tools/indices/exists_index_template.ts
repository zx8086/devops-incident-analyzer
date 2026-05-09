/* src/tools/indices/exists_index_template.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDiscoveryRequestOptions } from "../../utils/discoveryRequestOptions.js";
import { logger } from "../../utils/logger.js";
import { booleanField } from "../../utils/zodHelpers.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

// Zod validator for runtime validation
const existsIndexTemplateValidator = z.object({
	name: z
		.string()
		.min(1, "Template name cannot be empty")
		.describe("Index template name to check existence for. Example: 'logs-template'"),
	local: booleanField().optional().describe("Return local information, do not retrieve the state from master node"),
	flatSettings: booleanField().optional().describe("Return settings in flat format"),
	masterTimeout: z.string().optional().describe("Timeout for connection to master node"),
});

type ExistsIndexTemplateParams = z.infer<typeof existsIndexTemplateValidator>;

function createExistsIndexTemplateMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "template_not_found" | "timeout";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		template_not_found: ErrorCode.InvalidParams,
		timeout: ErrorCode.InternalError,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_exists_index_template] ${message}`, context.details);
}

// Tool implementation
export const registerExistsIndexTemplateTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const existsIndexTemplateHandler = async (args: ExistsIndexTemplateParams): Promise<SearchResult> => {
		try {
			// Validate parameters
			const params = existsIndexTemplateValidator.parse(args);

			logger.debug({ name: params.name }, "Checking if index template exists");

			const result = await esClient.indices.existsIndexTemplate(
				{
					name: params.name,
					local: params.local,
					flat_settings: params.flatSettings,
					master_timeout: params.masterTimeout,
				},
				{
					...getDiscoveryRequestOptions(),
					opaqueId: "elasticsearch_exists_index_template",
				},
			);

			return {
				content: [{ type: "text", text: JSON.stringify({ exists: result }, null, 2) }],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createExistsIndexTemplateMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error) {
				if (
					error.message.includes("index_template_missing_exception") ||
					error.message.includes("resource_not_found")
				) {
					throw createExistsIndexTemplateMcpError(`Template not found: ${args?.name}`, {
						type: "template_not_found",
						details: { originalError: error.message },
					});
				}

				if (error.message.includes("timeout") || error.message.includes("timed_out")) {
					throw createExistsIndexTemplateMcpError(`Operation timed out: ${error.message}`, {
						type: "timeout",
						details: { originalError: error.message },
					});
				}
			}

			throw createExistsIndexTemplateMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { args },
			});
		}
	};

	// Tool registration
	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_exists_index_template",

		{
			title: "Exists Index Template",

			description:
				"Check if index templates exist in Elasticsearch. Best for template validation, deployment verification, configuration checks. Use when you need to verify index template presence before operations in Elasticsearch.",

			inputSchema: existsIndexTemplateValidator.shape,
		},

		existsIndexTemplateHandler,
	);
};
