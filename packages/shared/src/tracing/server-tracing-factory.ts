// shared/src/tracing/server-tracing-factory.ts
import type pino from "pino";
import type { DataSourceId } from "../datasource.ts";
import { initializeTracing as sharedInitializeTracing, type TracingOptions } from "./langsmith.ts";
import { traceToolCall as sharedTraceToolCall } from "./tool-trace.ts";

export interface ServerTracingConfig {
	dataSourceId: DataSourceId;
	/** Env var checked first for the LangSmith project name, e.g. "ATLASSIAN_LANGSMITH_PROJECT". */
	projectEnvVar: string;
	defaultProject: string;
	log: pino.Logger;
}

export interface ServerTracing {
	initializeTracing: (options?: TracingOptions) => void;
	traceToolCall: <T>(toolName: string, handler: () => Promise<T>) => Promise<T>;
}

// SIO-1043: every mcp-server's utils/tracing.ts duplicated this pair, differing only
// in dataSourceId / project env var / default project name / logger instance.
export function createServerTracing(config: ServerTracingConfig): ServerTracing {
	const { dataSourceId, projectEnvVar, defaultProject, log } = config;

	function initializeTracing(options?: TracingOptions): void {
		const project = process.env[projectEnvVar] || process.env.LANGSMITH_PROJECT || defaultProject;
		sharedInitializeTracing({ project, ...options });
	}

	async function traceToolCall<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
		const startTime = Date.now();
		log.info({ tool: toolName, dataSource: dataSourceId }, `Tool call started: ${toolName}`);
		try {
			const result = await sharedTraceToolCall(toolName, handler, { dataSourceId });
			const duration = Date.now() - startTime;
			log.info({ tool: toolName, dataSource: dataSourceId, duration }, `Tool call completed: ${toolName}`);
			return result;
		} catch (error) {
			const duration = Date.now() - startTime;
			log.error(
				{
					tool: toolName,
					dataSource: dataSourceId,
					duration,
					error: error instanceof Error ? error.message : String(error),
				},
				`Tool call failed: ${toolName}`,
			);
			throw error;
		}
	}

	return { initializeTracing, traceToolCall };
}
