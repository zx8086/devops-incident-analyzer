// src/tools/transform/get_transform_stats.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const getTransformStatsValidator = z.object({
	transformId: z
		.string()
		.min(1, "transformId cannot be empty")
		.describe("Transform id, wildcard expression, or `_all` / `*` for every transform."),
	allowNoMatch: z.boolean().optional().describe("If true (default), partial/empty matches return 200 instead of 404."),
	from: z.number().int().min(0).optional().describe("Skip the first N transforms."),
	size: z.number().int().min(1).max(1000).optional().describe("Max stats entries to return. Range 1-1000."),
	timeout: z.string().optional().describe("Period to wait for the stats response (e.g. `30s`, `5m`)."),
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

			// Surface the operator-relevant fields up-front so polling output is scannable.
			const summary = result.transforms.map((t) => {
				const checkpointing = t.checkpointing as
					| { last?: { checkpoint?: number; timestamp_millis?: number }; next?: unknown }
					| undefined;
				const health = (t as { health?: { status?: string } }).health;
				const node = (t as { node?: { id?: string; name?: string } }).node;
				return [
					`- \`${t.id}\``,
					`  state=${t.state}`,
					`  health=${health?.status ?? "unknown"}`,
					`  node=${node?.name ?? node?.id ?? "n/a"}`,
					`  last_checkpoint=${checkpointing?.last?.checkpoint ?? "n/a"}`,
					`  has_next_checkpoint=${checkpointing?.next !== undefined}`,
				].join(" ");
			});

			const human = [`**Transform stats (count: ${result.count})**`, ...summary].join("\n");

			return {
				content: [
					{ type: "text", text: human },
					{ type: "text", text: JSON.stringify(result, null, 2) },
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
				"Get runtime stats for one or more transforms (`GET _transform/{id}/_stats`). Returns state, health, current node, indexer stats, search/index failure counters, memory pressure, and checkpoint progress. Use this to poll a transform after `elasticsearch_start_transform` to confirm it actually started. Supports wildcards and `_all`. Read-only.",
			inputSchema: getTransformStatsValidator.shape,
		},
		handler,
	);
};
