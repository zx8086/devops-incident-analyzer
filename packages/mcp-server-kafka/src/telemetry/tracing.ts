// src/telemetry/tracing.ts
// Re-exports from shared tracing module with kafka-specific defaults
import {
	isTracingActive,
	initializeTracing as sharedInitializeTracing,
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
	logger.info({ tool: toolName, dataSource: "kafka" }, `Tool call started: ${toolName}`);

	try {
		const result = await sharedTraceToolCall(toolName, handler, { dataSourceId: "kafka" });
		const duration = Date.now() - startTime;
		logger.info({ tool: toolName, dataSource: "kafka", duration }, `Tool call completed: ${toolName}`);
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error(
			{
				tool: toolName,
				dataSource: "kafka",
				duration,
				error: error instanceof Error ? error.message : String(error),
			},
			`Tool call failed: ${toolName}`,
		);
		throw error;
	}
}
