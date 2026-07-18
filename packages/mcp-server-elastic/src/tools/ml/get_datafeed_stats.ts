// src/tools/ml/get_datafeed_stats.ts

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlGetDatafeedStatsValidator = z.object({
	datafeedId: z
		.string()
		.optional()
		.describe(
			"Datafeed id, comma-separated list, or wildcard expression. Omit (or use `_all` / `*`) to return stats for every datafeed.",
		),
	allowNoMatch: z
		.boolean()
		.optional()
		.describe("If true (default), empty/partial matches return 200 with an empty `datafeeds` array instead of 404."),
	verbose: z
		.boolean()
		.optional()
		.describe(
			"If true, include the full raw ES stats body alongside the derived summary. Default false to keep payloads compact.",
		),
});

type MlGetDatafeedStatsParams = z.infer<typeof mlGetDatafeedStatsValidator>;

function createMlGetDatafeedStatsMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_get_datafeed_stats] ${message}`, context.details);
}

function summarizeDatafeedStats(df: estypes.MlDatafeedStats): Record<string, unknown> {
	return {
		datafeed_id: df.datafeed_id,
		state: df.state,
		assignment_explanation: df.assignment_explanation,
		node: df.node?.name,
		search_count: df.timing_stats?.search_count,
		bucket_count: df.timing_stats?.bucket_count,
		average_search_time_per_bucket_ms: df.timing_stats?.average_search_time_per_bucket_ms,
	};
}

function renderDatafeedStatsLine(s: Record<string, unknown>): string {
	return `- ${s.datafeed_id}: state=${s.state}, searches=${s.search_count ?? "n/a"}, buckets=${s.bucket_count ?? "n/a"}`;
}

export const registerMlGetDatafeedStatsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlGetDatafeedStatsParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlGetDatafeedStatsParams | undefined;
		try {
			params = mlGetDatafeedStatsValidator.parse(args);

			const result = await esClient.ml.getDatafeedStats({
				datafeed_id: params.datafeedId,
				allow_no_match: params.allowNoMatch ?? true,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, datafeedId: params.datafeedId }, "Slow ML op: get_datafeed_stats");
			}

			const summaries = result.datafeeds.map(summarizeDatafeedStats);
			const headline = `**ML datafeed stats (count: ${result.count})**`;
			const human = [headline, ...summaries.map(renderDatafeedStatsLine)].join("\n");

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
				throw createMlGetDatafeedStatsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlGetDatafeedStatsMcpError("Insufficient permissions to read ML datafeed stats", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found") || error.message.includes("No datafeed")) {
					throw createMlGetDatafeedStatsMcpError(`ML datafeed '${params?.datafeedId ?? "<all>"}' not found`, {
						type: "not_found",
						details: { datafeedId: params?.datafeedId },
					});
				}
			}
			throw createMlGetDatafeedStatsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_get_datafeed_stats",
		{
			title: "Get ML Datafeed Stats",
			description:
				"Get datafeed stats (`GET _ml/datafeeds/{datafeed_id}/_stats`). READ-ONLY. Returns datafeed state (started/stopped/starting/stopping) and search timing. Pair with `elasticsearch_ml_get_job_stats` to confirm a job's datafeed is feeding data before/after a lifecycle change. Supports a single id, comma-separated list, wildcard, or `_all`.",
			inputSchema: mlGetDatafeedStatsValidator.shape,
		},
		handler,
	);
};
