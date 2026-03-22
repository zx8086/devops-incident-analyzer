// observability/src/logger.ts
import pino from "pino";

function createBaseLogger(): pino.Logger {
  const level = Bun.env.LOG_LEVEL ?? "info";

  // pino-pretty is optional -- use plain JSON if not available
  if (Bun.env.NODE_ENV !== "production") {
    try {
      require.resolve("pino-pretty");
      return pino({ level, transport: { target: "pino-pretty", options: { colorize: true } } });
    } catch {
      // pino-pretty not installed, use plain output
    }
  }

  return pino({ level });
}

const baseLogger = createBaseLogger();

export function getLogger(service: string): pino.Logger {
  return baseLogger.child({ service });
}

export function getChildLogger(parent: pino.Logger, component: string): pino.Logger {
  return parent.child({ component });
}
