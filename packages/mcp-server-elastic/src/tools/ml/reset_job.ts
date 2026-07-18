// src/tools/ml/reset_job.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlResetJobValidator = z.object({
	jobId: z
		.string()
		.min(1, "jobId cannot be empty")
		.describe("Anomaly detection job id to reset. The job must be closed."),
	force: z
		.boolean()
		.optional()
		.describe(
			"Confirmation gate. Reset is DESTRUCTIVE and IRREVERSIBLE — it permanently discards ALL accumulated anomaly results and the entire trained model for the job. You MUST pass `force: true` to proceed; without it the tool refuses and does not touch the job. Only set true after confirming the underlying cause of the model degradation is resolved.",
		),
	waitForCompletion: z
		.boolean()
		.optional()
		.describe(
			"If true (default in ES), wait until the reset finishes before returning. If false, returns a task id and resets asynchronously.",
		),
	deleteUserAnnotations: z
		.boolean()
		.optional()
		.describe("If true, ALSO delete user-added annotations along with the auto-generated ones. Default false."),
});

type MlResetJobParams = z.infer<typeof mlResetJobValidator>;

function createMlResetJobMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_reset_job] ${message}`, context.details);
}

export const registerMlResetJobTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlResetJobParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlResetJobParams | undefined;
		try {
			params = mlResetJobValidator.parse(args);

			// Force-confirmation gate: reset permanently discards results + model state.
			// Mirror delete_transform's destructive posture but at whole-operation granularity —
			// refuse to call ml.resetJob at all until the caller explicitly confirms with force:true.
			if (!params.force) {
				throw createMlResetJobMcpError(
					`Refusing to reset '${params.jobId}' without confirmation. Reset is IRREVERSIBLE — it permanently deletes all accumulated anomaly results and the trained model for this job. Re-invoke with \`force: true\` ONLY after the underlying cause of the model degradation is confirmed resolved. After the reset the job is left CLOSED — reopen with \`elasticsearch_ml_open_job\` and restart its datafeed with \`elasticsearch_ml_start_datafeed\`.`,
					{ type: "validation", details: { jobId: params.jobId, forceRequired: true } },
				);
			}

			// Existing-resource preflight (mirrors delete_transform's getTransform check) so a
			// bad job id returns a clean not-found before the destructive call.
			try {
				await esClient.ml.getJobs({ job_id: params.jobId, allow_no_match: false });
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message.includes("resource_not_found") || error.message.includes("No known job"))
				) {
					throw createMlResetJobMcpError(`ML job '${params.jobId}' does not exist`, {
						type: "not_found",
						details: { jobId: params.jobId },
					});
				}
				throw error;
			}

			const result = await esClient.ml.resetJob({
				job_id: params.jobId,
				wait_for_completion: params.waitForCompletion,
				delete_user_annotations: params.deleteUserAnnotations,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, jobId: params.jobId }, "Slow ML op: reset_job");
			}

			logger.info({ jobId: params.jobId, acknowledged: result.acknowledged }, "ML job reset (destructive)");

			return {
				content: [
					{
						type: "text",
						text: `**ML job reset: ${params.jobId}**\nacknowledged=${result.acknowledged}\n\nWARNING: all accumulated results and model state for this job have been permanently discarded.\n\nNext steps: the job is now CLOSED — reopen it with \`elasticsearch_ml_open_job\`, then restart its datafeed with \`elasticsearch_ml_start_datafeed\` to rebuild the model.`,
					},
					{
						type: "text",
						text: JSON.stringify(
							{
								acknowledged: result.acknowledged,
								jobId: params.jobId,
								deleteUserAnnotations: params.deleteUserAnnotations ?? false,
								operation: "reset_job",
								timestamp: new Date().toISOString(),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (error) {
			if (error instanceof McpError) throw error;
			if (error instanceof z.ZodError) {
				throw createMlResetJobMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlResetJobMcpError("Insufficient permissions to reset ML job", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found") || error.message.includes("No known job")) {
					throw createMlResetJobMcpError(`ML job '${params?.jobId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { jobId: params?.jobId },
					});
				}
				if (
					error.message.includes("must be closed") ||
					error.message.includes("cannot reset") ||
					error.message.includes("opened")
				) {
					throw createMlResetJobMcpError(
						`ML job '${params?.jobId ?? "<unset>"}' must be CLOSED before reset. Stop its datafeed (\`elasticsearch_ml_stop_datafeed\`) then close it (\`elasticsearch_ml_close_job\`) first.`,
						{ type: "state_conflict", details: { jobId: params?.jobId } },
					);
				}
			}
			throw createMlResetJobMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_reset_job",
		{
			title: "Reset ML Job",
			description:
				"Reset an anomaly-detection job (`POST _ml/anomaly_detectors/{job_id}/_reset`). DESTRUCTIVE OPERATION — permanently discards all accumulated results and the trained model, and is IRREVERSIBLE. Requires explicit `force: true` (the tool refuses without it) and the job must already be CLOSED. Full recovery sequence: `elasticsearch_ml_stop_datafeed` -> `elasticsearch_ml_close_job` -> `elasticsearch_ml_reset_job` (force:true) -> `elasticsearch_ml_open_job` -> `elasticsearch_ml_start_datafeed`. Only reset once the root cause of the model degradation is confirmed resolved.",
			inputSchema: mlResetJobValidator.shape,
		},
		handler,
	);
};
