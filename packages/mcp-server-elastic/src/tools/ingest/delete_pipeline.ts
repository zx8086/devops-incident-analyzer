// tools/ingest/delete_pipeline.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { OperationType, withReadOnlyCheck } from "../../utils/readOnlyMode.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

const deletePipelineValidator = z.object({
	id: z.string().min(1, "Pipeline ID cannot be empty"),
	timeout: z.string().optional(),
	masterTimeout: z.string().optional(),
});

function createDeletePipelineMcpError(
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
		`[elasticsearch_delete_ingest_pipeline] ${message}`,
		context.details,
	);
}

export const registerDeleteIngestPipelineTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const deletePipelineHandler = async (args: unknown): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			const params = deletePipelineValidator.parse(args);

			logger.info({ pipelineId: params.id }, "Deleting ingest pipeline");

			const result = await esClient.ingest.deletePipeline(
				{
					id: params.id,
					timeout: params.timeout,
					master_timeout: params.masterTimeout,
				},
				{ opaqueId: "elasticsearch_delete_ingest_pipeline" },
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, pipelineId: params.id }, "Slow pipeline deletion");
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
				throw createDeletePipelineMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error && error.message.includes("resource_not_found_exception")) {
				throw createDeletePipelineMcpError(`Pipeline not found: ${(args as { id?: string })?.id}`, {
					type: "not_found",
					details: { pipelineId: (args as { id?: string })?.id },
				});
			}

			throw createDeletePipelineMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_delete_ingest_pipeline",
		{
			title: "Delete Ingest Pipeline",
			description:
				"Delete an ingest pipeline. Use elasticsearch_get_ingest_pipeline to verify the pipeline exists before deleting. Indices referencing this pipeline as default_pipeline will stop enriching new documents. DESTRUCTIVE OPERATION.",
			inputSchema: {
				id: z.string(), // Pipeline ID to delete. Supports wildcard patterns (e.g., 'my-pipeline-*').
				timeout: z.string().optional(), // Operation timeout (e.g., '30s')
				masterTimeout: z.string().optional(), // Master node timeout (e.g., '30s')
			},
		},
		withReadOnlyCheck("elasticsearch_delete_ingest_pipeline", deletePipelineHandler, OperationType.DESTRUCTIVE),
	);
};
