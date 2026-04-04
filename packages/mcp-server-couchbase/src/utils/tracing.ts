// src/utils/tracing.ts
// Re-exports from shared tracing module with couchbase-specific defaults
import {
	isTracingActive,
	initializeTracing as sharedInitializeTracing,
	traceToolCall as sharedTraceToolCall,
	type TracingOptions,
} from "@devops-agent/shared";
import { logger } from "../utils/logger";

export { isTracingActive };

export function initializeTracing(options?: TracingOptions): void {
	const project = process.env.COUCHBASE_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "couchbase-mcp-server";
	sharedInitializeTracing({ project, ...options });
}

export async function traceToolCall<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
	const startTime = Date.now();
	logger.info({ tool: toolName, dataSource: "couchbase" }, `Tool call started: ${toolName}`);

	try {
		const result = await sharedTraceToolCall(toolName, handler, { dataSourceId: "couchbase" });
		const duration = Date.now() - startTime;
		logger.info({ tool: toolName, dataSource: "couchbase", duration }, `Tool call completed: ${toolName}`);
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error(
			{
				tool: toolName,
				dataSource: "couchbase",
				duration,
				error: error instanceof Error ? error.message : String(error),
			},
			`Tool call failed: ${toolName}`,
		);
		throw error;
	}
}
