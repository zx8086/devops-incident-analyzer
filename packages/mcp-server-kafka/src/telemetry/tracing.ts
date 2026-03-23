// src/telemetry/tracing.ts
// Re-exports from shared tracing module with kafka-specific defaults
import {
	initializeTracing as sharedInitializeTracing,
	isTracingActive,
	traceToolCall as sharedTraceToolCall,
	type TracingOptions,
} from "@devops-agent/shared";
import { getLogger } from "../logging/container.ts";

export { isTracingActive };

export function initializeTracing(options?: TracingOptions): void {
	const project = process.env.KAFKA_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "kafka-mcp-server";
	sharedInitializeTracing({ project, ...options });
}

export async function traceToolCall<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
	const logger = getLogger();
	const startTime = Date.now();
	logger.info(`Tool call started: ${toolName} [dataSource=kafka]`);

	try {
		const result = await sharedTraceToolCall(toolName, handler, { dataSourceId: "kafka" });
		const duration = Date.now() - startTime;
		logger.info(`Tool call completed: ${toolName} [dataSource=kafka, duration=${duration}ms]`);
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error(
			`Tool call failed: ${toolName} [dataSource=kafka, duration=${duration}ms, error=${error instanceof Error ? error.message : String(error)}]`,
		);
		throw error;
	}
}

export { traceToolCall as traceToolExecution };
