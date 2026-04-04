// src/utils/logger.ts
import { createMcpLogger, getChildLogger } from "@devops-agent/shared";

export const logger = createMcpLogger("konnect-mcp-server");

export function createContextLogger(context: string) {
	return getChildLogger(logger, context);
}
