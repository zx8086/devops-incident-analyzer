// src/utils/tracing.ts
import {
	type ConnectionContext,
	createServerTracing,
	isTracingActive,
	traceConnection as sharedTraceConnection,
} from "@devops-agent/shared";
import { createContextLogger } from "./logger.js";

export type { ConnectionContext };
export { isTracingActive };

const { initializeTracing, traceToolCall } = createServerTracing({
	dataSourceId: "konnect",
	projectEnvVar: "KONNECT_LANGSMITH_PROJECT",
	defaultProject: "konnect-mcp-server",
	log: createContextLogger("tool"),
});

export { initializeTracing, traceToolCall };

export function traceConnection<T>(context: ConnectionContext, handler: () => Promise<T>): Promise<T> {
	return sharedTraceConnection(context, handler, { dataSourceId: "konnect" });
}
