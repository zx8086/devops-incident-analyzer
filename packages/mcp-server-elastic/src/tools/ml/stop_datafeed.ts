// src/tools/ml/stop_datafeed.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlStopDatafeedValidator = z.object({
	datafeedId: z
		.string()
		.min(1, "datafeedId cannot be empty")
		.describe("Datafeed id, comma-separated list, wildcard, or `_all` / `*` to stop every datafeed."),
	force: z
		.boolean()
		.optional()
		.describe("Forcefully stop the datafeed even if it is failing to stop cleanly. Reversible (it can be restarted)."),
	allowNoMatch: z.boolean().optional().describe("If true (default), partial/empty matches return 200 instead of 404."),
	timeout: z.string().optional().describe("Period to wait for the datafeed to stop (e.g. `20s`)."),
});

type MlStopDatafeedParams = z.infer<typeof mlStopDatafeedValidator>;

function createMlStopDatafeedMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_stop_datafeed] ${message}`, context.details);
}

export const registerMlStopDatafeedTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlStopDatafeedParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlStopDatafeedParams | undefined;
		try {
			params = mlStopDatafeedValidator.parse(args);

			const result = await esClient.ml.stopDatafeed({
				datafeed_id: params.datafeedId,
				force: params.force,
				allow_no_match: params.allowNoMatch ?? true,
				timeout: params.timeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, datafeedId: params.datafeedId }, "Slow ML op: stop_datafeed");
			}

			logger.info(
				{ datafeedId: params.datafeedId, stopped: result.stopped, force: params.force },
				"ML datafeed stopped",
			);

			return {
				content: [
					{
						type: "text",
						text: `**ML datafeed stop requested: ${params.datafeedId}**\nstopped=${result.stopped}\n\nThe job can now be closed with \`elasticsearch_ml_close_job\`. Verify with \`elasticsearch_ml_get_datafeed_stats\` (\`state=stopped\`).`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								stopped: result.stopped,
								datafeedId: params.datafeedId,
								force: params.force ?? false,
								operation: "stop_datafeed",
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
				throw createMlStopDatafeedMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlStopDatafeedMcpError("Insufficient permissions to stop ML datafeed", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found") || error.message.includes("No datafeed")) {
					throw createMlStopDatafeedMcpError(`ML datafeed '${params?.datafeedId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { datafeedId: params?.datafeedId },
					});
				}
				if (error.message.includes("Timeout") || error.message.includes("408")) {
					throw createMlStopDatafeedMcpError(
						`Stop timeout for '${params?.datafeedId ?? "<unset>"}'. It continues moving to STOPPED in the background — poll \`elasticsearch_ml_get_datafeed_stats\`. Pass \`force=true\` on retry if it is stuck.`,
						{ type: "timeout", details: { datafeedId: params?.datafeedId, providedTimeout: params?.timeout } },
					);
				}
			}
			throw createMlStopDatafeedMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_stop_datafeed",
		{
			title: "Stop ML Datafeed",
			description:
				"Stop a datafeed (`POST _ml/datafeeds/{datafeed_id}/_stop`). WRITE OPERATION. This is the FIRST step of a job reset: stop the datafeed, then `elasticsearch_ml_close_job`, then `elasticsearch_ml_reset_job`. `force=true` is reversible (the datafeed can be restarted). Supports `_all`, wildcards, and comma-separated lists. Verify with `elasticsearch_ml_get_datafeed_stats`.",
			inputSchema: mlStopDatafeedValidator.shape,
		},
		handler,
	);
};
