// src/tools/transform/start_transform.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { withSecurityValidation } from "../../utils/securityEnhancer.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const startTransformValidator = z.object({
	transformId: z.string().min(1, "transformId cannot be empty").describe("Transform id to start."),
	timeout: z
		.string()
		.optional()
		.describe(
			"Period to wait for synchronous start. This tool defaults to `5m` (overriding the ES default of `30s`, which often returns 408 even when the start succeeds asynchronously). Pass an explicit value to override.",
		),
	fromTimestamp: z
		.string()
		.optional()
		.describe(
			"For continuous transforms, restrict the set of transformed entities to those changed after this time (e.g. `now-30d`, ISO timestamp).",
		),
});

type StartTransformParams = z.infer<typeof startTransformValidator>;

function createStartTransformMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_start_transform] ${message}`, context.details);
}

export const registerStartTransformTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: StartTransformParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: StartTransformParams | undefined;
		try {
			params = startTransformValidator.parse(args);

			// SIO-831: Default to 5m (overrides ES's 30s default) to avoid the misleading-408
			// footgun where a successful asynchronous start returns a timeout error.
			const effectiveTimeout = params.timeout ?? "5m";
			const result = await esClient.transform.startTransform({
				transform_id: params.transformId,
				timeout: effectiveTimeout,
				from: params.fromTimestamp,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, transformId: params.transformId }, "Slow transform op: start_transform");
			}

			logger.info({ transformId: params.transformId, acknowledged: result.acknowledged }, "Transform started");

			return {
				content: [
					{
						type: "text",
						text: `**Transform started: ${params.transformId}**\nacknowledged=${result.acknowledged}\n\nNext step: poll \`elasticsearch_get_transform_stats\` to confirm \`state=started\` and check checkpoint progress.`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								acknowledged: result.acknowledged,
								transformId: params.transformId,
								operation: "start_transform",
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
				throw createStartTransformMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createStartTransformMcpError("Insufficient permissions to start transform", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found")) {
					throw createStartTransformMcpError(`Transform '${params?.transformId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { transformId: params?.transformId },
					});
				}
				if (error.message.includes("Timeout") || error.message.includes("408")) {
					throw createStartTransformMcpError(
						`Synchronous start timeout for '${params?.transformId ?? "<unset>"}'. The transform may still be starting in the background — poll \`elasticsearch_get_transform_stats\` to confirm. Pass a longer \`timeout\` (e.g. \`5m\`) on retry.`,
						{ type: "timeout", details: { transformId: params?.transformId, providedTimeout: params?.timeout } },
					);
				}
				if (error.message.includes("Cannot start") || error.message.includes("task_already_exists")) {
					throw createStartTransformMcpError(
						`Transform '${params?.transformId ?? "<unset>"}' is already running or in conflicting state: ${error.message}`,
						{
							type: "state_conflict",
							details: { transformId: params?.transformId },
						},
					);
				}
			}
			throw createStartTransformMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	const secureHandler = withSecurityValidation("elasticsearch_start_transform", handler);

	server.registerTool(
		"elasticsearch_start_transform",
		{
			title: "Start Transform",
			description:
				"Start an Elasticsearch transform (`POST _transform/{id}/_start`). WRITE OPERATION. This tool defaults `timeout` to `5m` (the ES default is 30s, which often returns a misleading 408 even when the start succeeds asynchronously). On a 408, the transform may still be starting in the background — poll `elasticsearch_get_transform_stats` to confirm. Use `fromTimestamp` to backfill continuous transforms.",
			inputSchema: startTransformValidator.shape,
		},
		secureHandler,
	);
};
