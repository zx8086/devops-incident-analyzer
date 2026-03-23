// shared/src/logger.ts
import { trace } from "@opentelemetry/api";
import pino from "pino";

const SENSITIVE_PATHS = [
	"*.token",
	"*.password",
	"*.secret",
	"*.apiKey",
	"*.api_key",
	"*.authorization",
	"*.credential",
	"*.accessToken",
	"*.access_token",
];

function isProd(): boolean {
	if (typeof globalThis.Bun !== "undefined") {
		return globalThis.Bun.env.NODE_ENV === "production";
	}
	return process.env.NODE_ENV === "production";
}

function getLogLevel(): string {
	if (typeof globalThis.Bun !== "undefined") {
		return globalThis.Bun.env.LOG_LEVEL ?? "info";
	}
	return process.env.LOG_LEVEL ?? "info";
}

export function createMcpLogger(serviceName: string): pino.Logger {
	const level = getLogLevel();

	if (!isProd()) {
		try {
			require.resolve("pino-pretty");
			return pino({
				level,
				redact: { paths: SENSITIVE_PATHS, censor: "[REDACTED]" },
				transport: {
					target: "pino-pretty",
					options: { colorize: true, destination: 2 },
				},
			}).child({ service: serviceName });
		} catch {
			// pino-pretty not installed, fall through to prod logger on stderr
		}
	}

	return pino(
		{
			level,
			redact: { paths: SENSITIVE_PATHS, censor: "[REDACTED]" },
			mixin() {
				const span = trace.getActiveSpan();
				if (!span) return {};
				const { traceId, spanId } = span.spanContext();
				return { "trace.id": traceId, "span.id": spanId };
			},
		},
		pino.destination({ dest: 2, sync: false }),
	).child({ service: serviceName });
}

export function getChildLogger(parent: pino.Logger, component: string): pino.Logger {
	return parent.child({ component });
}

export async function measureOperation<T>(
	parentLogger: pino.Logger,
	operation: string,
	fn: () => Promise<T>,
): Promise<T> {
	const startTime = Date.now();
	parentLogger.debug({ operation }, `Operation started: ${operation}`);
	try {
		const result = await fn();
		parentLogger.debug({ operation, duration: Date.now() - startTime }, `Operation completed: ${operation}`);
		return result;
	} catch (error) {
		parentLogger.error(
			{
				operation,
				duration: Date.now() - startTime,
				error: error instanceof Error ? error.message : String(error),
			},
			`Operation failed: ${operation}`,
		);
		throw error;
	}
}
