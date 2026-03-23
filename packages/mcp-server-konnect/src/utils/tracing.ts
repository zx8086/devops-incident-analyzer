// src/utils/tracing.ts
// Re-exports from shared tracing module with konnect-specific defaults
import {
	initializeTracing as sharedInitializeTracing,
	isTracingActive,
	traceToolCall as sharedTraceToolCall,
	traceConnection as sharedTraceConnection,
	type ConnectionContext,
	type TracingOptions,
} from "@devops-agent/shared";
import { mcpLogger } from "./mcp-logger.js";

export { isTracingActive };
export type { ConnectionContext };

export function initializeTracing(options?: TracingOptions): void {
	const project = process.env.LANGSMITH_PROJECT || "konnect-mcp-server";
	sharedInitializeTracing({ project, ...options });
}

export function traceToolCall<T>(
	toolName: string,
	handler: () => Promise<T>,
	metadata?: { category?: string; toolArgs?: Record<string, unknown> },
): Promise<T> {
	return sharedTraceToolCall(toolName, handler, {
		dataSourceId: "konnect",
		toolArgs: metadata?.toolArgs,
	});
}

export function traceConnection<T>(context: ConnectionContext, handler: () => Promise<T>): Promise<T> {
	return sharedTraceConnection(context, handler, { dataSourceId: "konnect" });
}

export function logTracingStatus(): void {
	const enabled = isTracingActive();
	const project = process.env.LANGSMITH_PROJECT || "konnect-mcp-server";
	mcpLogger.info("tracing", "Tracing status", { enabled, project });
}
