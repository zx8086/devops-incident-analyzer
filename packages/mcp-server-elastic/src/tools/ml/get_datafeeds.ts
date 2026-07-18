// src/tools/ml/get_datafeeds.ts

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const mlGetDatafeedsValidator = z.object({
	datafeedId: z
		.string()
		.optional()
		.describe(
			"Datafeed id or wildcard expression. Omit (or use `_all` / `*`) to return every datafeed's configuration.",
		),
	allowNoMatch: z
		.boolean()
		.optional()
		.describe("If true (default), empty/partial matches return 200 with an empty `datafeeds` array instead of 404."),
	excludeGenerated: z
		.boolean()
		.optional()
		.describe("If true, strip generated fields so the config is portable to another cluster. Default false."),
	verbose: z
		.boolean()
		.optional()
		.describe(
			"If true, include the full raw datafeed config alongside the derived summary. Default false to keep payloads compact.",
		),
});

type MlGetDatafeedsParams = z.infer<typeof mlGetDatafeedsValidator>;

function createMlGetDatafeedsMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_ml_get_datafeeds] ${message}`, context.details);
}

function summarizeDatafeed(df: estypes.MlDatafeed): Record<string, unknown> {
	return {
		datafeed_id: df.datafeed_id,
		job_id: df.job_id,
		indices: df.indices,
		frequency: df.frequency,
		query_delay: df.query_delay,
		scroll_size: df.scroll_size,
	};
}

function renderDatafeedLine(s: Record<string, unknown>): string {
	const indices = Array.isArray(s.indices) ? s.indices.join(",") : String(s.indices ?? "");
	return `- ${s.datafeed_id} -> job=${s.job_id}, indices=[${indices}]`;
}

export const registerMlGetDatafeedsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: MlGetDatafeedsParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: MlGetDatafeedsParams | undefined;
		try {
			params = mlGetDatafeedsValidator.parse(args);

			const result = await esClient.ml.getDatafeeds({
				datafeed_id: params.datafeedId,
				allow_no_match: params.allowNoMatch ?? true,
				exclude_generated: params.excludeGenerated,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, datafeedId: params.datafeedId }, "Slow ML op: get_datafeeds");
			}

			const summaries = result.datafeeds.map(summarizeDatafeed);
			const headline = `**ML datafeeds (count: ${result.count})**`;
			const human = [headline, ...summaries.map(renderDatafeedLine)].join("\n");

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
				throw createMlGetDatafeedsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createMlGetDatafeedsMcpError("Insufficient permissions to read ML datafeeds", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found") || error.message.includes("No datafeed")) {
					throw createMlGetDatafeedsMcpError(`ML datafeed '${params?.datafeedId ?? "<all>"}' not found`, {
						type: "not_found",
						details: { datafeedId: params?.datafeedId },
					});
				}
			}
			throw createMlGetDatafeedsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_ml_get_datafeeds",
		{
			title: "Get ML Datafeeds",
			description:
				"List datafeed configurations (`GET _ml/datafeeds/{datafeed_id}`). READ-ONLY. Returns each datafeed's id, its owning `job_id`, source `indices`, and polling frequency — the config analogue of `elasticsearch_ml_list_jobs`. For live datafeed state (started/stopped) use `elasticsearch_ml_get_datafeed_stats` instead.",
			inputSchema: mlGetDatafeedsValidator.shape,
		},
		handler,
	);
};
