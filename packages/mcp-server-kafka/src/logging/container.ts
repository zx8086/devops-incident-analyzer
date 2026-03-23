// src/logging/container.ts
import { createMcpLogger } from "@devops-agent/shared";
import type pino from "pino";

let _logger: pino.Logger = createMcpLogger("kafka-mcp-server");

export function getLogger(): pino.Logger {
	return _logger;
}

export function setLogger(newLogger: pino.Logger): void {
	_logger = newLogger;
}

export function resetLoggerContainer(): void {
	_logger = createMcpLogger("kafka-mcp-server");
}

export function createContextLogger(context: string, metadata: Record<string, unknown> = {}): pino.Logger {
	return _logger.child({ component: context, ...metadata });
}
