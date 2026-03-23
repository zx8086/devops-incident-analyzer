// src/telemetry/tracing.ts
// Re-exports from shared tracing module with kafka-specific defaults
import {
	initializeTracing as sharedInitializeTracing,
	isTracingActive,
	traceToolCall as sharedTraceToolCall,
	type TracingOptions,
} from "@devops-agent/shared";

export { isTracingActive };

export function initializeTracing(options?: TracingOptions): void {
	const project = process.env.KAFKA_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "kafka-mcp-server";
	sharedInitializeTracing({ project, ...options });
}

export function traceToolCall<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
	return sharedTraceToolCall(toolName, handler, { dataSourceId: "kafka" });
}

export { traceToolCall as traceToolExecution };
