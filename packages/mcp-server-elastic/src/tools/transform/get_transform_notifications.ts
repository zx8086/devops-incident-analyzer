// src/tools/transform/get_transform_notifications.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

export const getTransformNotificationsValidator = z.object({
	transformId: z
		.string()
		.optional()
		.describe("Filter notifications to a specific transform id. Omit to read across all transforms."),
	level: z.enum(["info", "warning", "error"]).optional().describe("Filter by notification level."),
	size: z
		.number()
		.int()
		.min(1)
		.max(1000)
		.optional()
		.describe("Max notifications to return. Range 1-1000 (default 50)."),
	from: z.number().int().min(0).optional().describe("Skip the first N notifications (pagination offset)."),
	since: z
		.string()
		.optional()
		.describe(
			'Time bound on `timestamp` (default `now-24h`). Accepts any ES date-math expression: `now-1h`, `now-7d`, ISO timestamp, etc. Pass an explicit older value like `now-30d` for historical sweeps; pass `""` to disable.',
		),
});

type GetTransformNotificationsParams = z.infer<typeof getTransformNotificationsValidator>;

function createGetTransformNotificationsMcpError(
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
	return new McpError(
		errorCodeMap[context.type],
		`[elasticsearch_get_transform_notifications] ${message}`,
		context.details,
	);
}

export const registerGetTransformNotificationsTool: ToolRegistrationFunction = (
	server: McpServer,
	esClient: Client,
) => {
	const handler = async (args: GetTransformNotificationsParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		try {
			const params = getTransformNotificationsValidator.parse(args);

			const filters: Record<string, unknown>[] = [];
			if (params.transformId) {
				filters.push({ term: { transform_id: params.transformId } });
			}
			if (params.level) {
				filters.push({ term: { level: params.level } });
			}
			// SIO-831: Default time bound so callers don't accidentally pull months of history.
			// Empty string opts out (caller explicitly wants all-time).
			const since = params.since ?? "now-24h";
			if (since !== "") {
				filters.push({ range: { timestamp: { gte: since } } });
			}

			const result = await esClient.search({
				index: ".transform-notifications-*",
				size: params.size ?? 50,
				from: params.from ?? 0,
				sort: [{ timestamp: { order: "desc" } }],
				query: filters.length ? { bool: { filter: filters } } : { match_all: {} },
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow transform op: get_transform_notifications");
			}

			const total = typeof result.hits.total === "number" ? result.hits.total : (result.hits.total?.value ?? 0);
			const lines = result.hits.hits.map((h) => {
				const src = h._source as
					| { timestamp?: string; level?: string; transform_id?: string; message?: string }
					| undefined;
				return `- ${src?.timestamp ?? "?"} [${src?.level ?? "?"}] ${src?.transform_id ?? "?"}: ${src?.message ?? ""}`;
			});

			const human = [
				`**Transform notifications** (total: ${total}, returned: ${result.hits.hits.length})`,
				params.transformId ? `Filter: transform_id=${params.transformId}` : null,
				params.level ? `Filter: level=${params.level}` : null,
				"",
				...lines,
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [
					{ type: "text", text: human },
					{ type: "text", text: JSON.stringify(result, null, 2) },
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createGetTransformNotificationsMcpError(
					`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`,
					{ type: "validation", details: { validationErrors: error.issues, providedArgs: args } },
				);
			}
			if (error instanceof Error && error.message.includes("security_exception")) {
				throw createGetTransformNotificationsMcpError(
					"Insufficient permissions to read .transform-notifications-* indices",
					{ type: "permission", details: { originalError: error.message } },
				);
			}
			throw createGetTransformNotificationsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_get_transform_notifications",
		{
			title: "Get Transform Notifications",
			description:
				'Read the transform audit log (`.transform-notifications-*`). Typed wrapper over `elasticsearch_search` with fixed index pattern, `timestamp:desc` sort, and optional `transform_id` / `level` / `since` filters. Defaults to `since: "now-24h"` so investigations of recent events don\'t pull months of audit history. Pass `since: ""` to disable the time bound. Read-only.',
			inputSchema: getTransformNotificationsValidator.shape,
		},
		handler,
	);
};
