// observability/src/logger.ts
import { createMcpLogger, getChildLogger as sharedGetChildLogger } from "@devops-agent/shared";
import type pino from "pino";

const baseLogger = createMcpLogger("devops-agent");

export function getLogger(service: string): pino.Logger {
	return baseLogger.child({ service });
}

export function getChildLogger(parent: pino.Logger, component: string): pino.Logger {
	return sharedGetChildLogger(parent, component);
}
