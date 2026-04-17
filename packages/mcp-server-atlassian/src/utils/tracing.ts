// src/utils/tracing.ts
import {
	type ConnectionContext,
	isTracingActive,
	initializeTracing as sharedInitializeTracing,
	traceConnection as sharedTraceConnection,
	traceToolCall as sharedTraceToolCall,
	type TracingOptions,
} from "@devops-agent/shared";
import { createContextLogger } from "./logger.js";

const log = createContextLogger("tool");

export type { ConnectionContext };
export { isTracingActive };

export function initializeTracing(options?: TracingOptions): void {
	const project = process.env.ATLASSIAN_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "atlassian-mcp-server";
	sharedInitializeTracing({ project, ...options });
}

export async function traceToolCall<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
	const startTime = Date.now();
	log.info({ tool: toolName, dataSource: "atlassian" }, `Tool call started: ${toolName}`);
	try {
		const result = await sharedTraceToolCall(toolName, handler, { dataSourceId: "atlassian" });
		const duration = Date.now() - startTime;
		log.info({ tool: toolName, dataSource: "atlassian", duration }, `Tool call completed: ${toolName}`);
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		log.error(
			{
				tool: toolName,
				dataSource: "atlassian",
				duration,
				error: error instanceof Error ? error.message : String(error),
			},
			`Tool call failed: ${toolName}`,
		);
		throw error;
	}
}

export function traceConnection<T>(context: ConnectionContext, handler: () => Promise<T>): Promise<T> {
	return sharedTraceConnection(context, handler, { dataSourceId: "atlassian" });
}
