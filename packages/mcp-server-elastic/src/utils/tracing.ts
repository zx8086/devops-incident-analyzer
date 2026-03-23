// src/utils/tracing.ts
// Re-exports from shared tracing module with elastic-specific defaults
import {
	type ConnectionContext,
	detectClient,
	generateSessionId,
	getCurrentTrace,
	initializeTracing as sharedInitializeTracing,
	isTracingActive,
	traceConnection as sharedTraceConnection,
	traceToolCall as sharedTraceToolCall,
	type TracingOptions,
	withNestedTrace,
} from "@devops-agent/shared";
import { config } from "../config.js";
import { logger } from "./logger.js";

export type { ConnectionContext };
export { detectClient, generateSessionId, getCurrentTrace, isTracingActive, withNestedTrace };

export interface TraceMetadata {
	connectionId?: string;
	sessionId?: string;
	conversationId?: string;
	conversationMessageCount?: number;
	isNewConversation?: boolean;
	transportMode?: string;
	toolName?: string;
	index?: string;
	operation?: string;
	queryType?: string;
	resultCount?: number;
	executionTime?: number;
	error?: string;
	[key: string]: unknown;
}

export function initializeTracing(options?: TracingOptions): void {
	const apiKey = config.langsmith.apiKey || process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY;
	const endpoint = process.env.LANGSMITH_ENDPOINT || config.langsmith.endpoint;
	const project = process.env.LANGSMITH_PROJECT || config.langsmith.project;

	// Elastic reads its own config object for tracing enablement
	const tracingEnabled =
		config.langsmith.tracing || process.env.LANGSMITH_TRACING === "true" || process.env.LANGCHAIN_TRACING_V2 === "true";

	if (tracingEnabled) {
		process.env.LANGSMITH_TRACING = "true";
	}

	sharedInitializeTracing({ apiKey, endpoint, project, ...options });
}

export async function traceToolCall(
	toolName: string,
	toolArgs: unknown,
	_extra: unknown,
	handler: (toolArgs: unknown, extra: unknown) => Promise<unknown>,
) {
	const startTime = Date.now();
	logger.info(`Tool call started: ${toolName}`, { tool: toolName, dataSource: "elastic" });

	try {
		const result = await sharedTraceToolCall(toolName, () => handler(toolArgs, _extra), {
			dataSourceId: "elastic",
			toolArgs:
				typeof toolArgs === "object" && toolArgs !== null ? (toolArgs as Record<string, unknown>) : undefined,
		});
		const duration = Date.now() - startTime;
		logger.info(`Tool call completed: ${toolName}`, { tool: toolName, dataSource: "elastic", duration });
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error(`Tool call failed: ${toolName}`, {
			tool: toolName,
			dataSource: "elastic",
			duration,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

// Backward-compat alias
export function traceToolExecution(
	toolName: string,
	toolArgs: unknown,
	extra: unknown,
	_context: unknown,
	handler: (toolArgs: unknown, extra: unknown) => Promise<unknown>,
) {
	return traceToolCall(toolName, toolArgs, extra, handler);
}

export async function traceConnection(context: ConnectionContext, handler: () => Promise<unknown>): Promise<unknown> {
	return sharedTraceConnection(context, handler, { dataSourceId: "elastic" });
}
