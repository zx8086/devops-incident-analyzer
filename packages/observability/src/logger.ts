// observability/src/logger.ts
import pino from "pino";

const isDev = Bun.env.NODE_ENV !== "production";

const baseLogger = pino({
  level: Bun.env.LOG_LEVEL ?? "info",
  transport: isDev ? { target: "pino-pretty", options: { colorize: true } } : undefined,
});

export function getLogger(service: string): pino.Logger {
  return baseLogger.child({ service });
}

export function getChildLogger(parent: pino.Logger, component: string): pino.Logger {
  return parent.child({ component });
}
