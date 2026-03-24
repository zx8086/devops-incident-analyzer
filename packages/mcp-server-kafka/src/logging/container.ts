// src/logging/container.ts
import { createMcpLogger, getChildLogger } from "@devops-agent/shared";
import type pino from "pino";

const _logger: pino.Logger = createMcpLogger("kafka-mcp-server");

export function getLogger(): pino.Logger {
	return _logger;
}

export function createContextLogger(context: string, metadata: Record<string, unknown> = {}): pino.Logger {
	return _logger.child({ component: context, ...metadata });
}
