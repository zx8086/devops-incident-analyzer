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
