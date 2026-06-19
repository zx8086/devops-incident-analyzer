// src/logger.ts
import pino from "pino";

export const logger = pino({
	name: "knowledge-graph-mcp-server",
	level: process.env.LOG_LEVEL ?? "info",
});

export function createContextLogger(context: string) {
	return logger.child({ context });
}
