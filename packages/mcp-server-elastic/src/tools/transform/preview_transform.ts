// src/tools/transform/preview_transform.ts

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

const sourceSchema = z
	.object({
		index: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
		query: z.record(z.string(), z.unknown()).optional(),
		runtime_mappings: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

const destSchema = z.object({ index: z.string().min(1).optional() }).passthrough();

export const previewTransformValidator = z
	.object({
		transformId: z
			.string()
			.optional()
			.describe("Existing transform id to preview. Mutually exclusive with body params (source/dest/pivot/latest)."),
		source: sourceSchema.optional().describe("Source config (only when previewing a non-existing transform)."),
		dest: destSchema.optional().describe("Destination config (optional preview-only field)."),
		pivot: z.record(z.string(), z.unknown()).optional().describe("Pivot config — mutually exclusive with `latest`."),
		latest: z.record(z.string(), z.unknown()).optional().describe("Latest config — mutually exclusive with `pivot`."),
		description: z.string().optional(),
		frequency: z.string().optional(),
		sync: z
			.object({ time: z.object({ field: z.string(), delay: z.string().optional() }).passthrough() })
			.passthrough()
			.optional(),
		settings: z.record(z.string(), z.unknown()).optional(),
		retention_policy: z.record(z.string(), z.unknown()).optional(),
		timeout: z.string().optional().describe("Period to wait for a response."),
	})
	.refine((v) => Boolean(v.transformId) || Boolean(v.source), {
		message: "Either `transformId` (preview existing) or `source` (preview new config) is required.",
		path: ["source"],
	})
	.refine(
		(v) => {
			if (v.transformId) {
				// Per ES API contract: when transformId is supplied, no body fields are allowed.
				return (
					!v.source &&
					!v.dest &&
					!v.pivot &&
					!v.latest &&
					v.description === undefined &&
					v.frequency === undefined &&
					!v.sync &&
					!v.settings &&
					!v.retention_policy
				);
			}
			return Boolean(v.pivot) !== Boolean(v.latest);
		},
		{
			message:
				"When previewing an existing `transformId`, do not pass any body fields (source/dest/pivot/latest/description/frequency/sync/settings/retention_policy). When previewing a new config, exactly one of `pivot` or `latest` must be set.",
			path: ["transformId"],
		},
	);

type PreviewTransformParams = z.infer<typeof previewTransformValidator>;

function createPreviewTransformMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "not_found" | "permission" | "parsing";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;
	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		not_found: ErrorCode.InvalidRequest,
		permission: ErrorCode.InvalidRequest,
		parsing: ErrorCode.InvalidParams,
	};
	return new McpError(errorCodeMap[context.type], `[elasticsearch_preview_transform] ${message}`, context.details);
}

export const registerPreviewTransformTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: PreviewTransformParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let params: PreviewTransformParams | undefined;
		try {
			params = previewTransformValidator.parse(args);

			const result = await esClient.transform.previewTransform({
				transform_id: params.transformId,
				timeout: params.timeout,
				source: params.source as estypes.TransformSource | undefined,
				dest: params.dest as estypes.TransformDestination | undefined,
				pivot: params.pivot as estypes.TransformPivot | undefined,
				latest: params.latest as estypes.TransformLatest | undefined,
				description: params.description,
				frequency: params.frequency,
				sync: params.sync as estypes.TransformSyncContainer | undefined,
				settings: params.settings as estypes.TransformSettings | undefined,
				retention_policy: params.retention_policy as estypes.TransformRetentionPolicyContainer | undefined,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow transform op: preview_transform");
			}

			const preview = result as { preview?: unknown[]; generated_dest_index?: unknown };
			const sampleCount = Array.isArray(preview.preview) ? preview.preview.length : 0;

			return {
				content: [
					{
						type: "text",
						text: `**Transform preview**\nSample documents: ${sampleCount} (max 100)\nGenerated destination mappings included.\n\nUse this output to validate the pivot/latest config before calling \`elasticsearch_put_transform\`.`,
					},
					{ type: "text", text: JSON.stringify(result, null, 2) },
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createPreviewTransformMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}
			if (error instanceof Error) {
				if (error.message.includes("security_exception")) {
					throw createPreviewTransformMcpError("Insufficient permissions to preview transform", {
						type: "permission",
						details: { originalError: error.message },
					});
				}
				if (error.message.includes("resource_not_found")) {
					throw createPreviewTransformMcpError(`Transform or source index not found`, {
						type: "not_found",
						details: { transformId: params?.transformId, source: params?.source },
					});
				}
				if (error.message.includes("parsing_exception")) {
					throw createPreviewTransformMcpError(`Invalid preview body: ${error.message}`, {
						type: "parsing",
						details: { suggestion: "Check pivot/latest, source.index, source.query" },
					});
				}
			}
			throw createPreviewTransformMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_preview_transform",
		{
			title: "Preview Transform",
			description:
				"Preview transform output (`POST _transform/_preview`). Returns up to 100 sample destination documents and the generated destination-index mappings. Read-only — does NOT create the transform. Use to validate a `pivot`/`latest` config before `elasticsearch_put_transform`. Pass either `transformId` (preview existing) or a new-config body (`source` + `pivot`-or-`latest`).",
			inputSchema: previewTransformValidator.shape,
		},
		handler,
	);
};
