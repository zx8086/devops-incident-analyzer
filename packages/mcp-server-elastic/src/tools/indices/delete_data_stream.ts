// tools/indices/delete_data_stream.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

const deleteDataStreamValidator = z.object({
	name: z
		.string()
		.min(1, "Data stream name cannot be empty")
		.describe("Data stream name or wildcard pattern (e.g., 'logs-*', 'profiling-events-*')"),
	expandWildcards: z
		.enum(["all", "open", "closed", "hidden", "none"])
		.optional()
		.describe("Which indices to expand wildcards to"),
});

type DeleteDataStreamParams = z.infer<typeof deleteDataStreamValidator>;

function createDeleteDataStreamMcpError(
	error: Error | string,
	context: { type: "validation" | "execution" | "not_found"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		not_found: ErrorCode.InvalidParams,
	};

	return new McpError(
		errorCodeMap[context.type] || ErrorCode.InternalError,
		`[elasticsearch_delete_data_stream] ${message}`,
		context.details,
	);
}

export const registerDeleteDataStreamTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const deleteDataStreamHandler = async (args: DeleteDataStreamParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			const params = deleteDataStreamValidator.parse(args);

			logger.info({ dataStream: params.name }, "Deleting data stream");

			const result = await esClient.indices.deleteDataStream(
				{
					name: params.name,
					expand_wildcards: params.expandWildcards,
				},
				{ opaqueId: "elasticsearch_delete_data_stream" },
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, dataStream: params.name }, "Slow data stream deletion");
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createDeleteDataStreamMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error && error.message.includes("data_stream_missing_exception")) {
				throw createDeleteDataStreamMcpError(`Data stream not found: ${args.name}`, {
					type: "not_found",
					details: { name: args.name },
				});
			}

			throw createDeleteDataStreamMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_delete_data_stream",
		{
			title: "Delete Data Stream",
			description:
				"Delete a data stream and all its backing indices. This is the correct way to remove time-series data (logs, metrics, traces). Cannot use delete_index on data stream backing indices -- use this tool instead. DESTRUCTIVE OPERATION: deletes the data stream and ALL backing indices permanently.",
			inputSchema: deleteDataStreamValidator.shape,
		},
		deleteDataStreamHandler,
	);
};
