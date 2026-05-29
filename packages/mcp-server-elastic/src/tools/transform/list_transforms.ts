// src/tools/transform/list_transforms.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const listTransformsValidator = z.object({
	from: z.number().int().min(0).optional().describe("Skip the first N transforms (pagination offset)."),
	size: z.number().int().min(1).max(1000).optional().describe("Max transforms to return. Range 1-1000."),
	excludeGenerated: z.boolean().optional().describe("Exclude fields added automatically by ES (for clean re-import)."),
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

			const lines = result.transforms.map((t) => {
				const sourceIdx = Array.isArray(t.source.index) ? t.source.index.join(",") : t.source.index;
				const mode = "pivot" in t && t.pivot ? "pivot" : "latest";
				return `- \`${t.id}\` (${mode}) -> ${t.dest.index} (from ${sourceIdx})`;
			});

			const human = [`**Transforms on cluster (count: ${result.count})**`, ...lines].join("\n");

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
				"List every transform on the cluster (`GET _transform/_all`) with pagination. Convenience over `elasticsearch_get_transform` for inventory work and dormancy audits. Read-only. Use `elasticsearch_get_transform_stats` for run-state.",
			inputSchema: listTransformsValidator.shape,
		},
		handler,
	);
};
