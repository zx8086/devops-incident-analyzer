// src/utils/logger.ts
import { createMcpLogger, measureOperation as sharedMeasureOperation } from "@devops-agent/shared";

export type LoggerInterface = ReturnType<typeof createMcpLogger>;

export const logger = createMcpLogger("couchbase-mcp-server");

export function createContextLogger(context: string) {
	return logger.child({ component: context });
}

export async function measureOperation<T>(
	operation: string,
	fn: () => Promise<T>,
	metadata: Record<string, unknown> = {},
): Promise<T> {
	const opLogger = metadata.context ? logger.child(metadata) : logger;
	return sharedMeasureOperation(opLogger, operation, fn);
}
