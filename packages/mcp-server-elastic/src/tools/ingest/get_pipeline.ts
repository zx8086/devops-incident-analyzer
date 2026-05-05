// tools/ingest/get_pipeline.ts

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, TextContent, ToolRegistrationFunction } from "../types.js";

const getPipelineValidator = z.object({
	id: z.string().optional().describe("Pipeline ID or wildcard pattern. Leave empty to get ALL pipelines."),
	summary: z
		.boolean()
		.optional()
		.describe(
			"Return summarized pipeline info (processor types, on_failure presence, grok patterns) instead of full JSON definitions.",
		),
});

type GetPipelineParams = z.infer<typeof getPipelineValidator>;

function summarizePipelines(pipelines: Record<string, any>): string {
	const lines: string[] = ["## Ingest Pipeline Summary\n"];

	for (const [name, def] of Object.entries(pipelines)) {
		const processors = def.processors ?? [];
		const onFailure = def.on_failure ?? [];
		const processorTypes = processors.map((p: Record<string, unknown>) => Object.keys(p)[0]);

		lines.push(`### ${name}`);
		if (def.description) lines.push(`- **Description**: ${def.description}`);
		lines.push(`- **Processors** (${processors.length}): ${processorTypes.join(", ") || "none"}`);
		lines.push(
			`- **on_failure handlers**: ${onFailure.length > 0 ? onFailure.length : "NONE (failures silently dropped)"}`,
		);

		// Flag grok processors specifically since they are common failure sources
		const grokProcessors = processors.filter((p: Record<string, unknown>) => "grok" in p);
		if (grokProcessors.length > 0) {
			lines.push(`- **Grok processors**: ${grokProcessors.length}`);
			for (const gp of grokProcessors) {
				const field = gp.grok?.field ?? "unknown";
				const patternCount = gp.grok?.patterns?.length ?? 0;
				lines.push(`  - field: \`${field}\`, patterns: ${patternCount}`);
			}
		}

		// Flag rename processors
		const renameProcessors = processors.filter((p: Record<string, unknown>) => "rename" in p);
		if (renameProcessors.length > 0) {
			lines.push(`- **Rename processors**: ${renameProcessors.length}`);
		}

		lines.push("");
	}

	return lines.join("\n");
}

export const registerGetIngestPipelineTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: GetPipelineParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		const requestId = Math.random().toString(36).substring(7);

		try {
			const params = getPipelineValidator.parse(args);

			logger.info({ pipelineId: params.id ?? "*" }, `[${requestId}] Getting ingest pipeline(s)`);

			const result = await esClient.ingest.getPipeline(
				{ id: params.id },
				{ opaqueId: "elasticsearch_get_ingest_pipeline" },
			);

			const pipelineCount = Object.keys(result).length;
			logger.info({ pipelineCount }, `[${requestId}] Retrieved ingest pipelines`);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, requestId }, "Slow get pipeline operation");
			}

			const responseContent = params.summary ? summarizePipelines(result) : JSON.stringify(result, null, 2);

			return {
				content: [{ type: "text", text: responseContent } as TextContent],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw new McpError(
					ErrorCode.InvalidParams,
					`[elasticsearch_get_ingest_pipeline] Validation failed: ${error.issues.map((e) => e.message).join(", ")}`,
				);
			}

			logger.error(
				{
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				},
				`[${requestId}] Failed to get ingest pipeline`,
			);

			throw new McpError(
				ErrorCode.InternalError,
				`[elasticsearch_get_ingest_pipeline] ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	server.registerTool(
		"elasticsearch_get_ingest_pipeline",
		{
			title: "Get Ingest Pipeline",
			description:
				"Get ingest pipeline definitions. Returns processor chains, on_failure handlers, grok patterns, and rename mappings. Use {summary: true} to get a concise overview of all pipelines including processor counts, grok patterns, and whether on_failure handlers exist. Essential for investigating ingest pipeline failures. READ operation - safe for production use.",
			inputSchema: getPipelineValidator.shape,
		},
		handler,
	);
};
