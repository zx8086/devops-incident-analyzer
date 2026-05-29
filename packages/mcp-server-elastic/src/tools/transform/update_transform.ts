// src/tools/transform/update_transform.ts

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { withSecurityValidation } from "../../utils/securityEnhancer.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// When `source` is provided in an update body, `index` MUST be set; the SDK rejects
// a bare {query} update because internally it merges over the existing source verbatim.
const sourceSchema = z
	.object({
		index: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
		query: z.record(z.string(), z.unknown()).optional(),
		runtime_mappings: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

const destSchema = z
	.object({
		index: z.string().min(1).optional(),
		pipeline: z.string().optional(),
	})
	.passthrough();

export const updateTransformValidator = z.object({
	transformId: z.string().min(1, "transformId cannot be empty").describe("Transform id to update."),
	source: sourceSchema.optional().describe("Updated source configuration (partial)."),
	dest: destSchema.optional().describe("Updated destination configuration (partial)."),
	description: z.string().optional().describe("Updated free-text description."),
	frequency: z.string().optional().describe("Updated check interval (1s–1h)."),
	sync: z
		.object({ time: z.object({ field: z.string(), delay: z.string().optional() }).passthrough() })
		.passthrough()
		.optional()
		.describe("Updated continuous-mode sync settings."),
	settings: z
		.object({
			max_page_search_size: z.number().int().min(10).max(65536).optional(),
			docs_per_second: z.number().optional(),
			dates_as_epoch_millis: z.boolean().optional(),
			align_checkpoints: z.boolean().optional(),
			deduce_mappings: z.boolean().optional(),
			// ES allows -1 (retry indefinitely) through 100.
			num_failure_retries: z.number().int().min(-1).max(100).optional(),
		})
		.passthrough()
		.optional()
		.describe("Updated transform settings (page size, throttling, retries)."),
	retention_policy: z
		.union([
			z.object({ time: z.object({ field: z.string(), max_age: z.string() }).passthrough() }).passthrough(),
			z.null(),
		])
		.optional()
		.describe("Updated retention policy. Pass `null` to remove."),
	_meta: z.record(z.string(), z.unknown()).optional().describe("Updated metadata."),
	deferValidation: z.boolean().optional().describe("Skip deferrable validations."),
	timeout: z.string().optional().describe("Period to wait for a response."),
});

type UpdateTransformParams = z.infer<typeof updateTransformValidator>;

function createUpdateTransformMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "not_found" | "permission" | "parsing";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;
	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		not_found: ErrorCode.InvalidRequest,
		permission: ErrorCode.InvalidRequest,
		parsing: ErrorCode.InvalidParams,
	};
	return new McpError(errorCodeMap[context.type], `[elasticsearch_update_transform] ${message}`, context.details);
}

export const registerUpdateTransformTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: UpdateTransformParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: UpdateTransformParams | undefined;
		try {
			params = updateTransformValidator.parse(args);

			const result = await esClient.transform.updateTransform({
				transform_id: params.transformId,
				defer_validation: params.deferValidation,
				timeout: params.timeout,
				source: params.source as estypes.TransformSource | undefined,
				dest: params.dest as estypes.TransformDestination | undefined,
				description: params.description,
				frequency: params.frequency,
				sync: params.sync as estypes.TransformSyncContainer | undefined,
				settings: params.settings as estypes.TransformSettings | undefined,
				retention_policy: params.retention_policy as estypes.TransformRetentionPolicyContainer | null | undefined,
				_meta: params._meta as estypes.Metadata | undefined,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, transformId: params.transformId }, "Slow transform op: update_transform");
			}

			logger.info({ transformId: params.transformId }, "Transform updated");

			return {
				content: [
					{
						type: "text",
						text: `**Transform updated: ${params.transformId}**\n\nNote: All updated properties except \`description\` take effect from the next checkpoint, not immediately. If the transform is running, the new settings will apply on the next checkpoint boundary.`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{ result, operation: "update_transform", timestamp: new Date().toISOString() },
							null,
							2,
						),
					},
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createUpdateTransformMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createUpdateTransformMcpError("Insufficient permissions to update transform", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found")) {
					throw createUpdateTransformMcpError(`Transform '${params?.transformId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { transformId: params?.transformId },
					});
				}
				if (error.message.includes("parsing_exception")) {
					throw createUpdateTransformMcpError(`Invalid update body: ${error.message}`, {
						type: "parsing",
						details: { suggestion: "Check field names and types in the update body" },
					});
				}
			}
			throw createUpdateTransformMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	const securityConfig = {
		maxInputSize: 1024 * 1024,
		enableInjectionDetection: true,
		enableXssProtection: true,
		enableCommandInjectionProtection: false,
		sensitiveFields: ["password", "api_key", "apiKey", "secret", "token", "auth"],
		maxQueryComplexity: 200,
	};

	const secureHandler = withSecurityValidation("elasticsearch_update_transform", handler, securityConfig);

	server.registerTool(
		"elasticsearch_update_transform",
		{
			title: "Update Transform",
			description:
				"Update an existing transform (`POST _transform/{id}/_update`). WRITE OPERATION. Cannot change `pivot`/`latest`; for that, delete and recreate. Updates other than `description` take effect from the next checkpoint, NOT immediately — current checkpoint completes with previous settings. Common use: tune `settings.docs_per_second` and `settings.max_page_search_size`.",
			inputSchema: updateTransformValidator.shape,
		},
		secureHandler,
	);
};
