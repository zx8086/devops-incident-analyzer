import { createMcpLogger } from "@devops-agent/shared";

export const logger = createMcpLogger("landing-zone-iac-mcp-server");

export function createContextLogger(context: string) {
	return logger.child({ context });
}
