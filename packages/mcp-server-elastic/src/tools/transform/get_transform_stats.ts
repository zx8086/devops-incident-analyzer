// src/tools/transform/get_transform_stats.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";
import { parseEsDuration, renderStatsSummaryLine, summarizeTransformStats } from "./summary.js";

export const getTransformStatsValidator = z.object({
	transformId: z
		.string()
		.min(1, "transformId cannot be empty")
		.describe("Transform id, wildcard expression, or `_all` / `*` for every transform."),
	allowNoMatch: z.boolean().optional().describe("If true (default), partial/empty matches return 200 instead of 404."),
	from: z.number().int().min(0).optional().describe("Skip the first N transforms."),
	size: z.number().int().min(1).max(1000).optional().describe("Max stats entries to return. Range 1-1000."),
	timeout: z.string().optional().describe("Period to wait for the stats response (e.g. `30s`, `5m`)."),
	verbose: z
		.boolean()
		.optional()
		.describe(
			"If true, include the full raw ES stats body alongside the derived summary. Default false to keep payloads compact — the summary already exposes state, health, node, checkpoint progress, failure rate, and stalled status.",
		),
	stalledAfter: z
		.string()
		.regex(/^\d+(ms|s|m|h|d)$/, "stalledAfter must be an ES duration like `24h`, `30m`, `7d`")
		.optional()
		.describe(
			"Threshold for the `is_stalled` derived field (default `24h`). A transform is stalled when its last checkpoint timestamp is older than `now - stalledAfter`.",
		),
});

type GetTransformStatsParams = z.infer<typeof getTransformStatsValidator>;

function createGetTransformStatsMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_get_transform_stats] ${message}`, context.details);
}

export const registerGetTransformStatsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: GetTransformStatsParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: GetTransformStatsParams | undefined;
		try {
			params = getTransformStatsValidator.parse(args);

			const result = await esClient.transform.getTransformStats({
				transform_id: params.transformId,
				allow_no_match: params.allowNoMatch ?? true,
				from: params.from,
				size: params.size,
				timeout: params.timeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, transformId: params.transformId }, "Slow transform op: get_transform_stats");
			}

			const stalledAfterMs = params.stalledAfter ? (parseEsDuration(params.stalledAfter) ?? undefined) : undefined;
			const summaries = result.transforms.map((t) => summarizeTransformStats(t, { stalledAfterMs }));

			const stalledCount = summaries.filter((s) => s.is_stalled).length;
			const headline = `**Transform stats (count: ${result.count}, stalled: ${stalledCount})**`;
			const human = [headline, ...summaries.map(renderStatsSummaryLine)].join("\n");

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
				throw createGetTransformStatsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof McpError) throw error;
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createGetTransformStatsMcpError("Insufficient permissions to read transform stats", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found")) {
					throw createGetTransformStatsMcpError(`Transform '${params?.transformId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { transformId: params?.transformId },
					});
				}
			}
			throw createGetTransformStatsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_get_transform_stats",
		{
			title: "Get Transform Stats",
			description:
				"Get runtime stats for one or more transforms (`GET _transform/{id}/_stats`). Returns a compact per-transform summary including state, health, node, last checkpoint number + age (seconds), failure rate, and `is_stalled` (checkpoint older than `stalledAfter`, default 24h). Pass `verbose: true` to also include the raw ES stats body. Use this to poll after `elasticsearch_start_transform` to confirm it actually started. Supports wildcards and `_all`. Read-only.",
			inputSchema: getTransformStatsValidator.shape,
		},
		handler,
	);
};
