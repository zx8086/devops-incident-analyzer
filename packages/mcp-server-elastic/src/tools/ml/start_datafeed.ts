// src/tools/ml/start_datafeed.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlStartDatafeedValidator = z.object({
	datafeedId: z.string().min(1, "datafeedId cannot be empty").describe("Datafeed id to start."),
	start: z
		.string()
		.optional()
		.describe(
			"Time to start analysing data from (ISO timestamp or e.g. `now-30d`). Omit to start from where the datafeed left off.",
		),
	end: z
		.string()
		.optional()
		.describe("Time to stop analysing at (ISO timestamp). Omit to run continuously in real time."),
	timeout: z.string().optional().describe("Period to wait for the datafeed to start (e.g. `20s`)."),
});

type MlStartDatafeedParams = z.infer<typeof mlStartDatafeedValidator>;

function createMlStartDatafeedMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_start_datafeed] ${message}`, context.details);
}

export const registerMlStartDatafeedTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlStartDatafeedParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlStartDatafeedParams | undefined;
		try {
			params = mlStartDatafeedValidator.parse(args);

			const result = await esClient.ml.startDatafeed({
				datafeed_id: params.datafeedId,
				start: params.start,
				end: params.end,
				timeout: params.timeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, datafeedId: params.datafeedId }, "Slow ML op: start_datafeed");
			}

			logger.info({ datafeedId: params.datafeedId, started: result.started, node: result.node }, "ML datafeed started");

			return {
				content: [
					{
						type: "text",
						text: `**ML datafeed started: ${params.datafeedId}**\nstarted=${result.started}, node=${JSON.stringify(result.node)}\n\nConfirm with \`elasticsearch_ml_get_datafeed_stats\` (\`state=started\`).`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								started: result.started,
								node: result.node,
								datafeedId: params.datafeedId,
								operation: "start_datafeed",
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
				throw createMlStartDatafeedMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlStartDatafeedMcpError("Insufficient permissions to start ML datafeed", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found") || error.message.includes("No datafeed")) {
					throw createMlStartDatafeedMcpError(`ML datafeed '${params?.datafeedId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { datafeedId: params?.datafeedId },
					});
				}
				if (error.message.includes("Timeout") || error.message.includes("408")) {
					throw createMlStartDatafeedMcpError(
						`Start timeout for '${params?.datafeedId ?? "<unset>"}'. It may still be starting — poll \`elasticsearch_ml_get_datafeed_stats\` to confirm \`state=started\`.`,
						{ type: "timeout", details: { datafeedId: params?.datafeedId, providedTimeout: params?.timeout } },
					);
				}
				if (
					error.message.includes("cannot start") ||
					error.message.includes("job") ||
					error.message.includes("closed")
				) {
					throw createMlStartDatafeedMcpError(
						`Cannot start datafeed '${params?.datafeedId ?? "<unset>"}' — its job must be open first. Call \`elasticsearch_ml_open_job\` before starting the datafeed.`,
						{ type: "state_conflict", details: { datafeedId: params?.datafeedId } },
					);
				}
			}
			throw createMlStartDatafeedMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_start_datafeed",
		{
			title: "Start ML Datafeed",
			description:
				"Start a datafeed (`POST _ml/datafeeds/{datafeed_id}/_start`). WRITE OPERATION. The owning job must already be open (`elasticsearch_ml_open_job`) or this fails. Omit `start`/`end` to resume continuous real-time analysis; set them to backfill a historical window. Confirm with `elasticsearch_ml_get_datafeed_stats` (`state=started`).",
			inputSchema: mlStartDatafeedValidator.shape,
		},
		handler,
	);
};
