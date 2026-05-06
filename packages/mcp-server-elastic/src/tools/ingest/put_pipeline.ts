// tools/ingest/put_pipeline.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

const putPipelineValidator = z.object({
	id: z.string().min(1, "Pipeline ID cannot be empty"),
	description: z.string().optional(),
	processors: z.array(z.record(z.string(), z.unknown())),
	on_failure: z.array(z.record(z.string(), z.unknown())).optional(),
	version: z.number().optional(),
	_meta: z.record(z.string(), z.unknown()).optional(),
	timeout: z.string().optional(),
	masterTimeout: z.string().optional(),
});

function createPutPipelineMcpError(
	error: Error | string,
	context: { type: "validation" | "execution"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
	};

	return new McpError(
		errorCodeMap[context.type] || ErrorCode.InternalError,
		`[elasticsearch_put_ingest_pipeline] ${message}`,
		context.details,
	);
}

export const registerPutIngestPipelineTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const putPipelineHandler = async (args: unknown): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			const params = putPipelineValidator.parse(args);

			logger.info(
				{ pipelineId: params.id, processorCount: params.processors.length },
				"Creating/updating ingest pipeline",
			);

			const result = await esClient.ingest.putPipeline(
				{
					id: params.id,
					description: params.description,
					processors: params.processors as Record<string, unknown>[],
					on_failure: params.on_failure as Record<string, unknown>[] | undefined,
					version: params.version,
					_meta: params._meta as Record<string, unknown> | undefined,
					timeout: params.timeout,
					master_timeout: params.masterTimeout,
				},
				{ opaqueId: "elasticsearch_put_ingest_pipeline" },
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, pipelineId: params.id }, "Slow pipeline creation");
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
				throw createPutPipelineMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error && error.message.includes("parse_exception")) {
				throw createPutPipelineMcpError(`Pipeline definition invalid: ${error.message}`, {
					type: "validation",
					details: { pipelineId: (args as { id?: string })?.id },
				});
			}

			throw createPutPipelineMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { duration: performance.now() - perfStart, args },
			});
		}
	};

	server.registerTool(
		"elasticsearch_put_ingest_pipeline",
		{
			title: "Create/Update Ingest Pipeline",
			description:
				"Create or update an ingest pipeline. Pipelines transform documents during indexing using processor chains (grok, rename, set, drop, script, etc.). Use elasticsearch_simulate_ingest_pipeline to test before deploying. WRITE OPERATION: modifies cluster state.",
			inputSchema: {
				id: z.string(), // Pipeline ID (name). Creates if new, overwrites if existing.
				description: z.string().optional(), // Human-readable description of what the pipeline does
				processors: z.array(z.record(z.string(), z.unknown())), // Ordered array of processor definitions, e.g. [{"grok": {"field": "message", "patterns": ["%{COMMONAPACHELOG}"]}}]
				on_failure: z.array(z.record(z.string(), z.unknown())).optional(), // Processors to run when the main pipeline fails. Omitting means failures are silently dropped.
				version: z.number().optional(), // Pipeline version for optimistic concurrency control
				_meta: z.record(z.string(), z.unknown()).optional(), // Arbitrary metadata attached to the pipeline definition
				timeout: z.string().optional(), // Operation timeout (e.g., '30s')
				masterTimeout: z.string().optional(), // Master node timeout (e.g., '30s')
			},
		},
		putPipelineHandler,
	);
};
