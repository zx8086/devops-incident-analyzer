// src/utils/tracing.ts
import { type ConnectionContext, createServerTracing } from "@devops-agent/shared";
import { createContextLogger } from "./logger.js";

export type { ConnectionContext };

const { initializeTracing, traceToolCall } = createServerTracing({
	dataSourceId: "elastic",
	projectEnvVar: "ELASTIC_LANGSMITH_PROJECT",
	defaultProject: "elastic-mcp-server",
	log: createContextLogger("tool"),
});

export { initializeTracing, traceToolCall };
