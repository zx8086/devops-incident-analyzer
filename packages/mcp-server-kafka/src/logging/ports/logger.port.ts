// src/logging/ports/logger.port.ts

export interface ILogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;

  child(bindings: Record<string, unknown>): ILogger;
  flush(): void | Promise<void>;
  reinitialize(options?: Record<string, unknown>): void;
}
