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
	dataSourceId: "gitlab",
	projectEnvVar: "GITLAB_LANGSMITH_PROJECT",
	defaultProject: "gitlab-mcp-server",
	log: createContextLogger("tool"),
});

export { initializeTracing, traceToolCall };

export function traceConnection<T>(context: ConnectionContext, handler: () => Promise<T>): Promise<T> {
	return sharedTraceConnection(context, handler, { dataSourceId: "gitlab" });
}
