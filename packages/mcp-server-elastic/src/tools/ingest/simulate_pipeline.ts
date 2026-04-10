// tools/ingest/simulate_pipeline.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, TextContent, ToolRegistrationFunction } from "../types.js";

const simulatePipelineValidator = z.object({
	id: z.string().optional(),
	docs: z.array(z.record(z.string(), z.unknown())),
	pipeline: z.record(z.string(), z.unknown()).optional(),
	verbose: z.boolean().optional(),
});

export const registerSimulateIngestPipelineTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: any): Promise<SearchResult> => {
		const perfStart = performance.now();
		const requestId = Math.random().toString(36).substring(7);

		try {
			const params = simulatePipelineValidator.parse(args);

			// Normalize docs to the format the ES client expects
			const docs = params.docs.map((doc: Record<string, unknown>) => ({
				_index: doc._index as string | undefined,
				_id: doc._id as string | undefined,
				_source: (doc._source ?? doc) as Record<string, unknown>,
			}));

			logger.info(
				{ pipelineId: params.id ?? "inline", docCount: docs.length, verbose: params.verbose },
				`[${requestId}] Simulating ingest pipeline`,
			);

			const result = await esClient.ingest.simulate(
				{
					id: params.id,
					docs,
					pipeline: params.pipeline as any,
					verbose: params.verbose,
				},
				{ opaqueId: "elasticsearch_simulate_ingest_pipeline" },
			);

			logger.info({ docCount: result.docs?.length ?? 0 }, `[${requestId}] Pipeline simulation complete`);

			const duration = performance.now() - perfStart;
			if (duration > 10000) {
				logger.warn({ duration, requestId }, "Slow pipeline simulation");
			}

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) } as TextContent],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw new McpError(
					ErrorCode.InvalidParams,
					`[elasticsearch_simulate_ingest_pipeline] Validation failed: ${error.issues.map((e) => e.message).join(", ")}`,
				);
			}

			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				},
				`[${requestId}] Failed to simulate ingest pipeline`,
			);

			throw new McpError(
				ErrorCode.InternalError,
				`[elasticsearch_simulate_ingest_pipeline] ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	server.registerTool(
		"elasticsearch_simulate_ingest_pipeline",
		{
			title: "Simulate Ingest Pipeline",
			description:
				"Simulate an ingest pipeline on sample documents to test processor behavior and debug failures. Pass {id} to test an existing pipeline, or provide an inline {pipeline} definition. Use {verbose: true} to see the output after each processor step. Useful for debugging grok pattern failures by running sample log lines through the pipeline. READ operation - does not modify any data.",
			inputSchema: {
				id: z.string().optional(), // ID of an existing pipeline to simulate. Omit if providing an inline pipeline definition.
				docs: z.array(z.record(z.string(), z.unknown())), // Array of sample documents. Each should have {_source: {...}} with the document body.
				pipeline: z.record(z.string(), z.unknown()).optional(), // Inline pipeline definition with {description, processors: [...]}. Use instead of {id}.
				verbose: z.boolean().optional(), // Show the result after each processor step, not just the final output.
			},
		},
		handler,
	);
};
