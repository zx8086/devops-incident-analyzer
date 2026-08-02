// src/telemetry/tracing.ts
import { createServerTracing, isTracingActive } from "@devops-agent/shared";
import { createContextLogger } from "../utils/logger.ts";

export { isTracingActive };

export const { initializeTracing, traceToolCall } = createServerTracing({
	dataSourceId: "aws",
	projectEnvVar: "AWS_LANGSMITH_PROJECT",
	defaultProject: "aws-mcp-server",
	log: createContextLogger("tool"),
});
