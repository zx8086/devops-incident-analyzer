// src/utils/tracing.ts
import {
	type ConnectionContext,
	createServerTracing,
	detectClient,
	generateSessionId,
	getCurrentTrace,
	isTracingActive,
	traceConnection as sharedTraceConnection,
	withNestedTrace,
} from "@devops-agent/shared";
import { createContextLogger } from "./logger.js";

export type { ConnectionContext };
export { detectClient, generateSessionId, getCurrentTrace, isTracingActive, withNestedTrace };

const { initializeTracing, traceToolCall } = createServerTracing({
	dataSourceId: "elastic",
	projectEnvVar: "ELASTIC_LANGSMITH_PROJECT",
	defaultProject: "elastic-mcp-server",
	log: createContextLogger("tool"),
});

export { initializeTracing, traceToolCall };

export async function traceConnection(context: ConnectionContext, handler: () => Promise<unknown>): Promise<unknown> {
	return sharedTraceConnection(context, handler, { dataSourceId: "elastic" });
}
