// src/logger.ts
import { createMcpLogger } from "@devops-agent/shared";

export const logger = createMcpLogger("knowledge-graph-mcp-server");

export function createContextLogger(context: string) {
	return logger.child({ context });
}
