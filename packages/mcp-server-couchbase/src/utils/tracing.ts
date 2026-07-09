// src/utils/tracing.ts
import { createServerTracing, isTracingActive } from "@devops-agent/shared";
import { createContextLogger } from "../utils/logger";

export { isTracingActive };

export const { initializeTracing, traceToolCall } = createServerTracing({
	dataSourceId: "couchbase",
	projectEnvVar: "COUCHBASE_LANGSMITH_PROJECT",
	defaultProject: "couchbase-mcp-server",
	log: createContextLogger("tool"),
});
