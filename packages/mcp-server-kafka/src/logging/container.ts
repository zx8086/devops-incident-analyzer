// src/logging/container.ts

import { createLogger } from "./create-logger.ts";
import type { ILogger } from "./ports/logger.port.ts";

let _logger: ILogger | null = null;

export function getLogger(): ILogger {
	if (!_logger) {
		_logger = createLogger();
	}
	return _logger;
}

export function setLogger(logger: ILogger): void {
	_logger = logger;
}

export function resetLoggerContainer(): void {
	_logger = null;
}

export function createContextLogger(context: string, metadata: Record<string, unknown> = {}): ILogger {
	return getLogger().child({ context, ...metadata });
}

export function measureOperation<T>(
	operation: string,
	fn: () => Promise<T>,
	metadata: Record<string, unknown> = {},
): Promise<T> {
	const logger = getLogger();
	const startTime = Date.now();
	return fn().finally(() => {
		const duration = Date.now() - startTime;
		logger.debug(`Operation completed: ${operation}`, { ...metadata, operation, duration });
	});
}
