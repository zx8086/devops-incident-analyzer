// src/utils/logger.ts
import { createMcpLogger } from "@devops-agent/shared";

export const logger = createMcpLogger("aws-mcp-server");

export function createContextLogger(component: string) {
	return logger.child({ component });
}
