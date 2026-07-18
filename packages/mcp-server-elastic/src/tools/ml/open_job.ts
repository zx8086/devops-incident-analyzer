// src/tools/ml/open_job.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlOpenJobValidator = z.object({
	jobId: z.string().min(1, "jobId cannot be empty").describe("Anomaly detection job id to open."),
	timeout: z
		.string()
		.optional()
		.describe("Period to wait for the job to open (e.g. `30s`, `5m`). ES default is `30m`."),
});

type MlOpenJobParams = z.infer<typeof mlOpenJobValidator>;

function createMlOpenJobMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_open_job] ${message}`, context.details);
}

export const registerMlOpenJobTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlOpenJobParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlOpenJobParams | undefined;
		try {
			params = mlOpenJobValidator.parse(args);

			const result = await esClient.ml.openJob({
				job_id: params.jobId,
				timeout: params.timeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, jobId: params.jobId }, "Slow ML op: open_job");
			}

			logger.info({ jobId: params.jobId, opened: result.opened, node: result.node }, "ML job opened");

			return {
				content: [
					{
						type: "text",
						text: `**ML job opened: ${params.jobId}**\nopened=${result.opened}, node=${result.node}\n\nNext step: start its datafeed with \`elasticsearch_ml_start_datafeed\` to resume analysis.`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								opened: result.opened,
								node: result.node,
								jobId: params.jobId,
								operation: "open_job",
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
				throw createMlOpenJobMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlOpenJobMcpError("Insufficient permissions to open ML job", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found") || error.message.includes("No known job")) {
					throw createMlOpenJobMcpError(`ML job '${params?.jobId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { jobId: params?.jobId },
					});
				}
				if (error.message.includes("Timeout") || error.message.includes("408")) {
					throw createMlOpenJobMcpError(
						`Open timeout for '${params?.jobId ?? "<unset>"}'. The job may still be opening — poll \`elasticsearch_ml_get_job_stats\` to confirm \`state=opened\`. Pass a longer \`timeout\` on retry.`,
						{ type: "timeout", details: { jobId: params?.jobId, providedTimeout: params?.timeout } },
					);
				}
			}
			throw createMlOpenJobMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_open_job",
		{
			title: "Open ML Job",
			description:
				"Open an anomaly-detection job (`POST _ml/anomaly_detectors/{job_id}/_open`). WRITE OPERATION. A job must be open before its datafeed can run. Use after `elasticsearch_ml_reset_job` (which leaves the job closed) or to resume a manually-closed job. Follow with `elasticsearch_ml_start_datafeed`. Confirm with `elasticsearch_ml_get_job_stats` (`state=opened`).",
			inputSchema: mlOpenJobValidator.shape,
		},
		handler,
	);
};
