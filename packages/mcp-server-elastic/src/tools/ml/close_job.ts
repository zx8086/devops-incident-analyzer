// src/tools/ml/close_job.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlCloseJobValidator = z.object({
	jobId: z
		.string()
		.min(1, "jobId cannot be empty")
		.describe("Job id, group name, comma-separated list, wildcard, or `_all` / `*` to close every job."),
	force: z
		.boolean()
		.optional()
		.describe(
			"Forcefully close the job even if data is being processed or it is in a failed state. Reversible (the job can be reopened). Use when a normal close hangs.",
		),
	allowNoMatch: z.boolean().optional().describe("If true (default), partial/empty matches return 200 instead of 404."),
	timeout: z.string().optional().describe("Period to wait for the close to complete (e.g. `30s`, `5m`)."),
});

type MlCloseJobParams = z.infer<typeof mlCloseJobValidator>;

function createMlCloseJobMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_close_job] ${message}`, context.details);
}

export const registerMlCloseJobTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlCloseJobParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlCloseJobParams | undefined;
		try {
			params = mlCloseJobValidator.parse(args);

			const result = await esClient.ml.closeJob({
				job_id: params.jobId,
				force: params.force,
				allow_no_match: params.allowNoMatch ?? true,
				timeout: params.timeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, jobId: params.jobId }, "Slow ML op: close_job");
			}

			logger.info({ jobId: params.jobId, closed: result.closed, force: params.force }, "ML job closed");

			return {
				content: [
					{
						type: "text",
						text: `**ML job close requested: ${params.jobId}**\nclosed=${result.closed}\n\nStop its datafeed first with \`elasticsearch_ml_stop_datafeed\` if it is still running. Verify with \`elasticsearch_ml_get_job_stats\` (\`state=closed\`).`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								closed: result.closed,
								jobId: params.jobId,
								force: params.force ?? false,
								operation: "close_job",
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
				throw createMlCloseJobMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlCloseJobMcpError("Insufficient permissions to close ML job", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found") || error.message.includes("No known job")) {
					throw createMlCloseJobMcpError(`ML job '${params?.jobId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { jobId: params?.jobId },
					});
				}
				if (error.message.includes("Timeout") || error.message.includes("408")) {
					throw createMlCloseJobMcpError(
						`Close timeout for '${params?.jobId ?? "<unset>"}'. If the datafeed is still running, stop it first with \`elasticsearch_ml_stop_datafeed\`, or pass \`force=true\`. Verify with \`elasticsearch_ml_get_job_stats\`.`,
						{ type: "timeout", details: { jobId: params?.jobId, providedTimeout: params?.timeout } },
					);
				}
				if (error.message.includes("datafeed") && error.message.includes("started")) {
					throw createMlCloseJobMcpError(
						`Cannot close '${params?.jobId ?? "<unset>"}' — its datafeed is still started. Call \`elasticsearch_ml_stop_datafeed\` first, or pass \`force=true\`.`,
						{ type: "state_conflict", details: { jobId: params?.jobId } },
					);
				}
			}
			throw createMlCloseJobMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_close_job",
		{
			title: "Close ML Job",
			description:
				"Close an anomaly-detection job (`POST _ml/anomaly_detectors/{job_id}/_close`). WRITE OPERATION. A job must be closed before it can be reset. Its datafeed must be stopped first (`elasticsearch_ml_stop_datafeed`) or the call fails unless `force=true`. `force=true` is reversible (the job can be reopened). Supports `_all`, wildcards, and comma-separated lists. Verify with `elasticsearch_ml_get_job_stats`.",
			inputSchema: mlCloseJobValidator.shape,
		},
		handler,
	);
};
