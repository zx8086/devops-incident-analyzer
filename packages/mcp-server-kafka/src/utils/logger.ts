// src/utils/logger.ts
import { createMcpLogger } from "@devops-agent/shared";

export const logger = createMcpLogger("kafka-mcp-server");

export function createContextLogger(context: string, metadata: Record<string, unknown> = {}) {
	return logger.child({ component: context, ...metadata });
}
