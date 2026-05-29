// src/tools/transform/list_transforms.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";
import { renderSummaryLine, summarizeTransform } from "./summary.js";

export const listTransformsValidator = z.object({
	from: z.number().int().min(0).optional().describe("Skip the first N transforms (pagination offset)."),
	size: z.number().int().min(1).max(1000).optional().describe("Max transforms to return. Range 1-1000."),
	excludeGenerated: z.boolean().optional().describe("Exclude fields added automatically by ES (for clean re-import)."),
	summary: z
		.boolean()
		.optional()
		.describe(
			"If true (default), return a compact one-line-per-transform projection (id, mode, source.index, dest.index, dest.pipeline, sync.field, retention, frequency). If false, return the full transform body. Default true to keep payloads under chat-buffer limits on clusters with many transforms.",
		),
});

type ListTransformsParams = z.infer<typeof listTransformsValidator>;

function createListTransformsMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "permission";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;
	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		permission: ErrorCode.InvalidRequest,
	};
	return new McpError(errorCodeMap[context.type], `[elasticsearch_list_transforms] ${message}`, context.details);
}

export const registerListTransformsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: ListTransformsParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		try {
			const params = listTransformsValidator.parse(args);
			const summaryMode = params.summary ?? true;

			const result = await esClient.transform.getTransform({
				transform_id: "_all",
				allow_no_match: true,
				from: params.from,
				size: params.size,
				exclude_generated: params.excludeGenerated,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow transform op: list_transforms");
			}

			if (summaryMode) {
				const summaries = result.transforms.map(summarizeTransform);
				const human = [
					`**Transforms on cluster (count: ${result.count})** — summary mode`,
					...summaries.map(renderSummaryLine),
					"",
					"Pass `summary: false` to retrieve the full transform bodies.",
				].join("\n");
				return {
					content: [
						{ type: "text", text: human },
						{ type: "text", text: JSON.stringify({ count: result.count, transforms: summaries }, null, 2) },
					],
				};
			}

			const lines = result.transforms.map((t) => renderSummaryLine(summarizeTransform(t)));
			const human = [`**Transforms on cluster (count: ${result.count})** — full mode`, ...lines].join("\n");
			return {
				content: [
					{ type: "text", text: human },
					{ type: "text", text: JSON.stringify(result, null, 2) },
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createListTransformsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof McpError) throw error;
			if (error instanceof Error && error.message.includes("security_exception")) {
				throw createListTransformsMcpError("Insufficient permissions to list transforms", {
					type: "permission",
					details: { originalError: error.message },
				});
			}
			throw createListTransformsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_list_transforms",
		{
			title: "List Transforms",
			description:
				"List every transform on the cluster (`GET _transform/_all`) with pagination. Defaults to compact summary mode (~200 bytes per transform) so 50+ transforms fit in a single tool result. Pass `summary: false` for the full transform bodies. Convenience over `elasticsearch_get_transform` for inventory work and dormancy audits. Read-only. Use `elasticsearch_get_transform_stats` for run-state.",
			inputSchema: listTransformsValidator.shape,
		},
		handler,
	);
};
