// observability/src/logger.ts
import pino from "pino";

function getEnv(key: string): string | undefined {
	// Support both Bun and Node.js environments (Vite SSR runs under Node)
	if (typeof globalThis.Bun !== "undefined") {
		return globalThis.Bun.env[key];
	}
	return process.env[key];
}

function createBaseLogger(): pino.Logger {
	const level = getEnv("LOG_LEVEL") ?? "info";

	if (getEnv("NODE_ENV") !== "production") {
		try {
			require.resolve("pino-pretty");
			return pino({ level, transport: { target: "pino-pretty", options: { colorize: true } } });
		} catch {
			// pino-pretty not installed
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
