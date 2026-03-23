// src/utils/tracing.ts
// Re-exports from shared tracing module with konnect-specific defaults
import {
	type ConnectionContext,
	initializeTracing as sharedInitializeTracing,
	isTracingActive,
	traceConnection as sharedTraceConnection,
	traceToolCall as sharedTraceToolCall,
	type TracingOptions,
} from "@devops-agent/shared";
import { mcpLogger } from "./mcp-logger.js";

export type { ConnectionContext };
export { isTracingActive };

export function initializeTracing(options?: TracingOptions): void {
	const project = process.env.LANGSMITH_PROJECT || "konnect-mcp-server";
	sharedInitializeTracing({ project, ...options });
}

export async function traceToolCall<T>(
	toolName: string,
	handler: () => Promise<T>,
	metadata?: { category?: string; toolArgs?: Record<string, unknown> },
): Promise<T> {
	const startTime = Date.now();
	mcpLogger.info("tool", `Tool call started: ${toolName}`, { tool: toolName, dataSource: "konnect" });

	try {
		const result = await sharedTraceToolCall(toolName, handler, {
			dataSourceId: "konnect",
			toolArgs: metadata?.toolArgs,
		});
		const duration = Date.now() - startTime;
		mcpLogger.info("tool", `Tool call completed: ${toolName}`, { tool: toolName, dataSource: "konnect", duration });
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		mcpLogger.error("tool", `Tool call failed: ${toolName}`, {
			tool: toolName,
			dataSource: "konnect",
			duration,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export function traceConnection<T>(context: ConnectionContext, handler: () => Promise<T>): Promise<T> {
	return sharedTraceConnection(context, handler, { dataSourceId: "konnect" });
}

export function logTracingStatus(): void {
	const enabled = isTracingActive();
	const project = process.env.LANGSMITH_PROJECT || "konnect-mcp-server";
	mcpLogger.info("tracing", "Tracing status", { enabled, project });
}
