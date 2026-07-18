// src/tools/ml/get_job_stats.ts

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlGetJobStatsValidator = z.object({
	jobId: z
		.string()
		.optional()
		.describe(
			"Anomaly detection job id, group name, comma-separated list, or wildcard expression. Omit (or use `_all` / `*`) to return stats for every job.",
		),
	allowNoMatch: z
		.boolean()
		.optional()
		.describe("If true (default), empty/partial matches return 200 with an empty `jobs` array instead of 404."),
	verbose: z
		.boolean()
		.optional()
		.describe(
			"If true, include the full raw ES stats body alongside the derived summary. Default false to keep payloads compact.",
		),
});

type MlGetJobStatsParams = z.infer<typeof mlGetJobStatsValidator>;

function createMlGetJobStatsMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "not_found" | "permission";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;
	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		not_found: ErrorCode.InvalidRequest,
		permission: ErrorCode.InvalidRequest,
	};
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_get_job_stats] ${message}`, context.details);
}

// Derives the fields the ML rollout health check cares about: job state, memory status,
// processing time, and the data-count drift signals (empty/sparse buckets, missing fields,
// last_data_time) that indicate a stale or numbed model.
function summarizeJobStats(job: estypes.MlJobStats): Record<string, unknown> {
	return {
		job_id: job.job_id,
		state: job.state,
		memory_status: job.model_size_stats?.memory_status,
		model_bytes: job.model_size_stats?.model_bytes,
		bucket_allocation_failures_count: job.model_size_stats?.bucket_allocation_failures_count,
		processed_record_count: job.data_counts?.processed_record_count,
		empty_bucket_count: job.data_counts?.empty_bucket_count,
		sparse_bucket_count: job.data_counts?.sparse_bucket_count,
		missing_field_count: job.data_counts?.missing_field_count,
		last_data_time: job.data_counts?.last_data_time,
		bucket_count: job.data_counts?.bucket_count,
		average_bucket_processing_time_ms: job.timing_stats?.average_bucket_processing_time_ms,
		open_time: job.open_time,
		assignment_explanation: job.assignment_explanation,
		node: job.node?.name,
	};
}

function renderJobStatsLine(s: Record<string, unknown>): string {
	return `- ${s.job_id}: state=${s.state}, memory=${s.memory_status}, processed=${s.processed_record_count}, empty_buckets=${s.empty_bucket_count}, missing_fields=${s.missing_field_count}, last_data=${s.last_data_time ?? "n/a"}`;
}

export const registerMlGetJobStatsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlGetJobStatsParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlGetJobStatsParams | undefined;
		try {
			params = mlGetJobStatsValidator.parse(args);

			const result = await esClient.ml.getJobStats({
				job_id: params.jobId,
				allow_no_match: params.allowNoMatch ?? true,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, jobId: params.jobId }, "Slow ML op: get_job_stats");
			}

			const summaries = result.jobs.map(summarizeJobStats);
			const headline = `**ML job stats (count: ${result.count})**`;
			const human = [headline, ...summaries.map(renderJobStatsLine)].join("\n");

			const verbose = params.verbose ?? false;
			const structured = verbose ? { count: result.count, summaries, raw: result } : { count: result.count, summaries };

			return {
				content: [
					{ type: "text", text: human },
					{ type: "text", text: JSON.stringify(structured, null, 2) },
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createMlGetJobStatsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlGetJobStatsMcpError("Insufficient permissions to read ML job stats", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found") || error.message.includes("No known job")) {
					throw createMlGetJobStatsMcpError(`ML job '${params?.jobId ?? "<all>"}' not found`, {
						type: "not_found",
						details: { jobId: params?.jobId },
					});
				}
			}
			throw createMlGetJobStatsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_get_job_stats",
		{
			title: "Get ML Job Stats",
			description:
				"Get anomaly-detection job stats (`GET _ml/anomaly_detectors/{job_id}/_stats`). READ-ONLY. Returns state (opened/closed/failed), memory status, processing time, and data-count drift signals (empty/sparse buckets, missing fields, last_data_time) — the inputs a model-health check uses to detect a numbed or stale job. Supports a single id, group, comma-separated list, wildcard, or `_all`. Use `verbose=true` for the full raw stats body.",
			inputSchema: mlGetJobStatsValidator.shape,
		},
		handler,
	);
};
