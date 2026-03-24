// src/utils/tracing.ts
import {
	type ConnectionContext,
	detectClient,
	generateSessionId,
	getCurrentTrace,
	isTracingActive,
	initializeTracing as sharedInitializeTracing,
	traceConnection as sharedTraceConnection,
	traceToolCall as sharedTraceToolCall,
	type TracingOptions,
	withNestedTrace,
} from "@devops-agent/shared";
import { logger } from "./logger.js";

export type { ConnectionContext };
export { detectClient, generateSessionId, getCurrentTrace, isTracingActive, withNestedTrace };

export function initializeTracing(options?: TracingOptions): void {
	const project = process.env.ELASTIC_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "elastic-mcp-server";
	sharedInitializeTracing({ project, ...options });
}

export async function traceToolCall<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
	const startTime = Date.now();
	logger.info({ tool: toolName, dataSource: "elastic" }, `Tool call started: ${toolName}`);

	try {
		const result = await sharedTraceToolCall(toolName, handler, { dataSourceId: "elastic" });
		const duration = Date.now() - startTime;
		logger.info({ tool: toolName, dataSource: "elastic", duration }, `Tool call completed: ${toolName}`);
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error(
			{
				tool: toolName,
				dataSource: "elastic",
				duration,
				error: error instanceof Error ? error.message : String(error),
			},
			`Tool call failed: ${toolName}`,
		);
		throw error;
	}
}

export async function traceConnection(context: ConnectionContext, handler: () => Promise<unknown>): Promise<unknown> {
	return sharedTraceConnection(context, handler, { dataSourceId: "elastic" });
}
