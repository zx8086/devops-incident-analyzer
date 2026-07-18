// src/tools/ml/list_jobs.ts

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlListJobsValidator = z.object({
	jobId: z
		.string()
		.optional()
		.describe(
			"Anomaly detection job id, group name, or wildcard expression. Omit (or use `_all` / `*`) to return every job's configuration.",
		),
	allowNoMatch: z
		.boolean()
		.optional()
		.describe("If true (default), empty/partial matches return 200 with an empty `jobs` array instead of 404."),
	excludeGenerated: z
		.boolean()
		.optional()
		.describe("If true, strip generated fields so the config is portable to another cluster. Default false."),
	verbose: z
		.boolean()
		.optional()
		.describe(
			"If true, include the full raw job config alongside the derived summary. Default false to keep payloads compact.",
		),
});

type MlListJobsParams = z.infer<typeof mlListJobsValidator>;

function createMlListJobsMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_list_jobs] ${message}`, context.details);
}

// The results_index_name is the `.ml-anomalies-{results_index_name}` suffix — the health check
// reads anomaly results out of that index, so surfacing it here lets a caller resolve the
// backing index without a second call.
function summarizeJob(job: estypes.MlJob): Record<string, unknown> {
	return {
		job_id: job.job_id,
		description: job.description,
		groups: job.groups,
		results_index_name: job.results_index_name,
		model_snapshot_id: job.model_snapshot_id,
		create_time: job.create_time,
		finished_time: job.finished_time,
	};
}

function renderJobLine(s: Record<string, unknown>): string {
	return `- ${s.job_id}: results_index=.ml-anomalies-${s.results_index_name}${s.description ? ` (${s.description})` : ""}`;
}

export const registerMlListJobsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlListJobsParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlListJobsParams | undefined;
		try {
			params = mlListJobsValidator.parse(args);

			const result = await esClient.ml.getJobs({
				job_id: params.jobId,
				allow_no_match: params.allowNoMatch ?? true,
				exclude_generated: params.excludeGenerated,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, jobId: params.jobId }, "Slow ML op: list_jobs");
			}

			const summaries = result.jobs.map(summarizeJob);
			const headline = `**ML anomaly-detection jobs (count: ${result.count})**`;
			const human = [headline, ...summaries.map(renderJobLine)].join("\n");

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
				throw createMlListJobsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlListJobsMcpError("Insufficient permissions to read ML jobs", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found") || error.message.includes("No known job")) {
					throw createMlListJobsMcpError(`ML job '${params?.jobId ?? "<all>"}' not found`, {
						type: "not_found",
						details: { jobId: params?.jobId },
					});
				}
			}
			throw createMlListJobsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_list_jobs",
		{
			title: "List ML Jobs",
			description:
				"List anomaly-detection job configurations (`GET _ml/anomaly_detectors/{job_id}`). READ-ONLY. Returns each job's id, description, groups, and `results_index_name` (the `.ml-anomalies-{name}` backing index). Omit `jobId` for all jobs. For live state/health (opened/closed, memory, data counts) use `elasticsearch_ml_get_job_stats` instead — this tool returns configuration, not runtime stats.",
			inputSchema: mlListJobsValidator.shape,
		},
		handler,
	);
};
