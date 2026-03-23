// src/utils/tracing.ts
// Re-exports from shared tracing module with couchbase-specific defaults
import {
	initializeTracing as sharedInitializeTracing,
	isTracingActive,
	traceToolCall as sharedTraceToolCall,
	type TracingOptions,
} from "@devops-agent/shared";
import { logger } from "../lib/logger";

export { isTracingActive };

export function initializeTracing(options?: TracingOptions): void {
	const project = process.env.COUCHBASE_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "couchbase-mcp-server";
	sharedInitializeTracing({ project, ...options });
}

export async function traceToolCall<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
	const startTime = Date.now();
	logger.info(`Tool call started: ${toolName}`, { tool: toolName, dataSource: "couchbase" });

	try {
		const result = await sharedTraceToolCall(toolName, handler, { dataSourceId: "couchbase" });
		const duration = Date.now() - startTime;
		logger.info(`Tool call completed: ${toolName}`, { tool: toolName, dataSource: "couchbase", duration });
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error(`Tool call failed: ${toolName}`, {
			tool: toolName,
			dataSource: "couchbase",
			duration,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export { traceToolCall as traceToolExecution };
