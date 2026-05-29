// src/tools/transform/stop_transform.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { withSecurityValidation } from "../../utils/securityEnhancer.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const stopTransformValidator = z.object({
	transformId: z
		.string()
		.min(1, "transformId cannot be empty")
		.describe("Transform id. Comma-separated list, wildcards, and `_all` / `*` are supported."),
	force: z
		.boolean()
		.optional()
		.describe(
			"Forcefully stop the transform. WARNING: a stuck `stopping` task can leave a persistent-task split-brain (the allocation lingers even after the transform reports STOPPED). If `force=true` does not actually free the allocation, follow up with `elasticsearch_delete_transform`.",
		),
	waitForCompletion: z
		.boolean()
		.optional()
		.describe(
			"If true, wait until the current checkpoint finishes before returning. If false, stop as soon as possible (default: false in SDK, but ES API treats it as false).",
		),
	timeout: z
		.string()
		.optional()
		.describe(
			"How long to wait when `waitForCompletion=true`. ES default is `30s`. A timeout here returns 408 but the transform continues moving to STOPPED in the background.",
		),
	allowNoMatch: z.boolean().optional().describe("If true (default), partial/empty matches return 200 instead of 404."),
});

type StopTransformParams = z.infer<typeof stopTransformValidator>;

function createStopTransformMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "not_found" | "permission" | "state_conflict" | "timeout";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;
	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		not_found: ErrorCode.InvalidRequest,
		permission: ErrorCode.InvalidRequest,
		state_conflict: ErrorCode.InvalidRequest,
		timeout: ErrorCode.InvalidRequest,
	};
	return new McpError(errorCodeMap[context.type], `[elasticsearch_stop_transform] ${message}`, context.details);
}

export const registerStopTransformTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: StopTransformParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: StopTransformParams | undefined;
		try {
			params = stopTransformValidator.parse(args);

			const result = await esClient.transform.stopTransform({
				transform_id: params.transformId,
				force: params.force,
				wait_for_completion: params.waitForCompletion,
				timeout: params.timeout,
				allow_no_match: params.allowNoMatch ?? true,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, transformId: params.transformId }, "Slow transform op: stop_transform");
			}

			logger.info({ transformId: params.transformId, force: params.force }, "Transform stopped");

			const forceWarning = params.force
				? "\n\nNOTE: `force=true` was used. If the transform task does not actually free its allocation, follow up with `elasticsearch_delete_transform` to clean up."
				: "";

			return {
				content: [
					{
						type: "text",
						text: `**Transform stop requested: ${params.transformId}**\nacknowledged=${result.acknowledged}${forceWarning}\n\nVerify state with \`elasticsearch_get_transform_stats\`.`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								acknowledged: result.acknowledged,
								transformId: params.transformId,
								force: params.force ?? false,
								operation: "stop_transform",
								timestamp: new Date().toISOString(),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createStopTransformMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createStopTransformMcpError("Insufficient permissions to stop transform", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found")) {
					throw createStopTransformMcpError(`Transform '${params?.transformId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { transformId: params?.transformId },
					});
				}
				if (error.message.includes("Timeout") || error.message.includes("408")) {
					throw createStopTransformMcpError(
						`Synchronous stop timeout for '${params?.transformId ?? "<unset>"}'. The transform continues moving to STOPPED in the background — poll \`elasticsearch_get_transform_stats\` to confirm. Pass a longer \`timeout\` (e.g. \`5m\`) on retry.`,
						{
							type: "timeout",
							details: { transformId: params?.transformId, providedTimeout: params?.timeout },
						},
					);
				}
			}
			throw createStopTransformMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	const secureHandler = withSecurityValidation("elasticsearch_stop_transform", handler);

	server.registerTool(
		"elasticsearch_stop_transform",
		{
			title: "Stop Transform",
			description:
				"Stop an Elasticsearch transform (`POST _transform/{id}/_stop`). WRITE OPERATION. Supports `_all`, wildcards, and comma-separated lists. `force=true` is reversible (the transform can be restarted) but can leave a persistent-task split-brain — if the allocation lingers, follow up with `elasticsearch_delete_transform`. A 408 on `waitForCompletion=true` does NOT mean the stop failed; verify with `elasticsearch_get_transform_stats`.",
			inputSchema: stopTransformValidator.shape,
		},
		secureHandler,
	);
};
