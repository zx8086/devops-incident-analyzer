// src/tools/transform/delete_transform.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const deleteTransformValidator = z.object({
	transformId: z.string().min(1, "transformId cannot be empty").describe("Transform id to delete."),
	force: z
		.boolean()
		.optional()
		.describe(
			"If true, delete even if the transform is running (it will be stopped first). If false (default), the transform must already be stopped.",
		),
	deleteDestIndex: z
		.boolean()
		.optional()
		.describe(
			"If true, ALSO delete the destination index. UNRECOVERABLE. Default false. Do not enable unless you have confirmed the destination index holds no data you need to keep.",
		),
	timeout: z.string().optional().describe("Period to wait for a response."),
});

type DeleteTransformParams = z.infer<typeof deleteTransformValidator>;

function createDeleteTransformMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "not_found" | "permission" | "state_conflict";
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
	};
	return new McpError(errorCodeMap[context.type], `[elasticsearch_delete_transform] ${message}`, context.details);
}

export const registerDeleteTransformTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: DeleteTransformParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: DeleteTransformParams | undefined;
		try {
			params = deleteTransformValidator.parse(args);

			try {
				await esClient.transform.getTransform({ transform_id: params.transformId, allow_no_match: false });
			} catch (error) {
				if (error instanceof Error && error.message.includes("resource_not_found")) {
					throw createDeleteTransformMcpError(`Transform '${params.transformId}' does not exist`, {
						type: "not_found",
						details: { transformId: params.transformId },
					});
				}
				throw error;
			}

			const result = await esClient.transform.deleteTransform({
				transform_id: params.transformId,
				force: params.force,
				delete_dest_index: params.deleteDestIndex,
				timeout: params.timeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, transformId: params.transformId }, "Slow transform op: delete_transform");
			}

			logger.info({ transformId: params.transformId, deleteDestIndex: params.deleteDestIndex }, "Transform deleted");

			const destWarning = params.deleteDestIndex
				? "\n\nWARNING: `deleteDestIndex=true` was used — the destination index has been removed and is unrecoverable."
				: "";

			return {
				content: [
					{
						type: "text",
						text: `**Transform deleted: ${params.transformId}**\nacknowledged=${result.acknowledged}${destWarning}`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								acknowledged: result.acknowledged,
								transformId: params.transformId,
								deleteDestIndex: params.deleteDestIndex ?? false,
								operation: "delete_transform",
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
				throw createDeleteTransformMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof McpError) throw error;
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createDeleteTransformMcpError("Insufficient permissions to delete transform", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found")) {
					throw createDeleteTransformMcpError(`Transform '${params?.transformId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { transformId: params?.transformId },
					});
				}
				if (error.message.includes("Cannot delete") || error.message.includes("must be stopped")) {
					throw createDeleteTransformMcpError(
						`Transform '${params?.transformId ?? "<unset>"}' must be stopped before delete. Pass \`force=true\` or call \`elasticsearch_stop_transform\` first.`,
						{ type: "state_conflict", details: { transformId: params?.transformId } },
					);
				}
			}
			throw createDeleteTransformMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_delete_transform",
		{
			title: "Delete Transform",
			description:
				"Delete an Elasticsearch transform (`DELETE _transform/{id}`). DESTRUCTIVE OPERATION. The transform must already be stopped, or pass `force=true` to stop+delete in one call. `deleteDestIndex=true` ALSO removes the destination index — this is UNRECOVERABLE and defaults to false. Use after `elasticsearch_stop_transform` for clean cleanup; use with `force=true` to recover from a persistent-task split-brain.",
			inputSchema: deleteTransformValidator.shape,
		},
		handler,
	);
};
