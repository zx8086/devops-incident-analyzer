// src/tools/transform/get_transform.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const getTransformValidator = z.object({
	transformId: z
		.string()
		.optional()
		.describe("Transform id. Supports wildcards and `_all` / `*` for every transform. Omit to list all transforms."),
	allowNoMatch: z.boolean().optional().describe("If true (default), partial/empty matches return 200 instead of 404."),
	from: z.number().int().min(0).optional().describe("Skip the first N transforms."),
	size: z.number().int().min(1).max(1000).optional().describe("Max transforms to return. Range 1-1000."),
	excludeGenerated: z.boolean().optional().describe("Exclude fields added automatically by ES (for clean re-import)."),
});

type GetTransformParams = z.infer<typeof getTransformValidator>;

function createGetTransformMcpError(
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
	return new McpError(errorCodeMap[context.type], `[elasticsearch_get_transform] ${message}`, context.details);
}

export const registerGetTransformTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: GetTransformParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: GetTransformParams | undefined;
		try {
			params = getTransformValidator.parse(args);

			const result = await esClient.transform.getTransform({
				transform_id: params.transformId,
				allow_no_match: params.allowNoMatch ?? true,
				from: params.from,
				size: params.size,
				exclude_generated: params.excludeGenerated,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, transformId: params.transformId }, "Slow transform op: get_transform");
			}

			const human = [
				`**Transforms (count: ${result.count})**`,
				...result.transforms.map((t) => {
					const sourceIdx = Array.isArray(t.source.index) ? t.source.index.join(",") : t.source.index;
					const mode = "pivot" in t && t.pivot ? "pivot" : "latest";
					return `- \`${t.id}\` (${mode}) source=${sourceIdx} dest=${t.dest.index} freq=${t.frequency ?? "default"}`;
				}),
			].join("\n");

			return {
				content: [
					{ type: "text", text: human },
					{ type: "text", text: JSON.stringify(result, null, 2) },
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createGetTransformMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof McpError) throw error;
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createGetTransformMcpError("Insufficient permissions to read transforms", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found")) {
					throw createGetTransformMcpError(`Transform '${params?.transformId ?? "<unset>"}' not found`, {
						type: "not_found",
						details: { transformId: params?.transformId },
					});
				}
			}
			throw createGetTransformMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_get_transform",
		{
			title: "Get Transform",
			description:
				"Get the configuration of one or more Elasticsearch transforms (`GET _transform/{id}`). Supports wildcards and `_all`. Read-only. Returns `{ count, transforms: [...] }`. For run-state and checkpoint progress use `elasticsearch_get_transform_stats`.",
			inputSchema: getTransformValidator.shape,
		},
		handler,
	);
};
