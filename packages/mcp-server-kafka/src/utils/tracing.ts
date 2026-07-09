// src/utils/tracing.ts
import { createServerTracing, isTracingActive } from "@devops-agent/shared";
import { createContextLogger } from "./logger.ts";

export { isTracingActive };

export const { initializeTracing, traceToolCall } = createServerTracing({
	dataSourceId: "kafka",
	projectEnvVar: "KAFKA_LANGSMITH_PROJECT",
	defaultProject: "kafka-mcp-server",
	log: createContextLogger("tool"),
});
