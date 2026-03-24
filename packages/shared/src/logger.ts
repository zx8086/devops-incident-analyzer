// shared/src/logger.ts
import ecsFormat from "@elastic/ecs-pino-format";
import { trace } from "@opentelemetry/api";
import pino from "pino";
import { getCurrentTrace } from "./tracing/langsmith.ts";

const SENSITIVE_KEYS = [
	"token",
	"password",
	"secret",
	"apiKey",
	"api_key",
	"authorization",
	"credential",
	"accessToken",
	"access_token",
];

// Redact both top-level and nested sensitive fields
const SENSITIVE_PATHS = [...SENSITIVE_KEYS, ...SENSITIVE_KEYS.map((k) => `*.${k}`)];

export function getEnv(key: string): string | undefined {
	if (typeof globalThis.Bun !== "undefined") {
		return globalThis.Bun.env[key];
	}
	return process.env[key];
}

export function isProdOrStaging(): boolean {
	const env = getEnv("NODE_ENV");
	return env === "production" || env === "staging";
}

function getLogLevel(): string {
	return getEnv("LOG_LEVEL") ?? "info";
}

// -- ECS Options Builder --

export interface EcsLoggerConfig {
	serviceName: string;
	serviceVersion?: string;
	serviceEnvironment?: string;
}

export function buildEcsOptions(config: EcsLoggerConfig): pino.LoggerOptions {
	const environment = config.serviceEnvironment ?? getEnv("NODE_ENV") ?? "development";
	const version = config.serviceVersion ?? "0.1.0";

	const ecsOptions = ecsFormat({
		apmIntegration: false,
		serviceName: config.serviceName,
		serviceVersion: version,
		serviceEnvironment: environment,
		convertErr: true,
		convertReqRes: true,
	});

	return {
		...ecsOptions,
		mixin() {
			const fields: Record<string, string> = {};

			// OTEL trace context
			const span = trace.getActiveSpan();
			if (span) {
				const ctx = span.spanContext();
				fields["trace.id"] = ctx.traceId;
				fields["span.id"] = ctx.spanId;
				fields["transaction.id"] = ctx.traceId;
			}

			// LangSmith context
			try {
				const runTree = getCurrentTrace();
				if (runTree) {
					fields["langsmith.run_id"] = runTree.id;
					fields["langsmith.trace_id"] = runTree.trace_id;
				}
				const project = getEnv("LANGSMITH_PROJECT") ?? getEnv("LANGCHAIN_PROJECT");
				if (project) {
					fields["langsmith.project"] = project;
				}
			} catch {
				// LangSmith not available
			}

			return fields;
		},
		redact: { paths: SENSITIVE_PATHS, censor: "[REDACTED]" },
	};
}

// -- Dev Console Formatter --

const ECS_METADATA_FIELDS = new Set([
	"@timestamp",
	"ecs.version",
	"log.level",
	"log.logger",
	"process.pid",
	"host.hostname",
	"service.name",
	"service.version",
	"service.environment",
	"event.dataset",
]);

const LEVEL_COLORS: Record<string, string> = {
	trace: "\x1b[90m",
	debug: "\x1b[36m",
	info: "\x1b[32m",
	warn: "\x1b[33m",
	error: "\x1b[31m",
	fatal: "\x1b[35m",
};
const RESET = "\x1b[0m";

export function formatLogLine(obj: Record<string, unknown>): string {
	// ECS format uses "log.level" string, standard Pino uses numeric "level"
	const ecsLevel = obj["log.level"] as string | undefined;
	const pinoLevel = obj.level as number | undefined;

	const levelName =
		ecsLevel?.toLowerCase() ||
		(pinoLevel === 10
			? "trace"
			: pinoLevel === 20
				? "debug"
				: pinoLevel === 30
					? "info"
					: pinoLevel === 40
						? "warn"
						: pinoLevel === 50
							? "error"
							: pinoLevel === 60
								? "fatal"
								: "info");

	// ECS uses "message", standard Pino uses "msg"
	const msg = (obj.message as string) || (obj.msg as string) || "";

	// ECS uses "@timestamp" ISO string, standard Pino uses "time" epoch
	const timestamp = obj["@timestamp"] as string | undefined;
	const pinoTime = obj.time as number | undefined;
	const date = timestamp ? new Date(timestamp) : new Date(pinoTime || Date.now());

	// Format time as "h:MM:ss TT"
	const hours = date.getHours();
	const ampm = hours >= 12 ? "PM" : "AM";
	const hour12 = hours % 12 || 12;
	const timeStr = `${hour12}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")} ${ampm}`;

	// Extract context -- exclude ECS metadata and standard Pino fields
	const context: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (["level", "time", "msg", "message", "pid", "hostname"].includes(key)) continue;
		if (ECS_METADATA_FIELDS.has(key)) continue;
		context[key] = value;
	}

	const color = LEVEL_COLORS[levelName] ?? "";
	const contextStr = Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : "";
	return `${timeStr} ${color}${levelName}${RESET}: ${msg}${contextStr}\n`;
}

export function createFormattedDestination(fd: 1 | 2): { write(data: string): void } {
	const target = fd === 1 ? process.stdout : process.stderr;
	return {
		write(data: string) {
			try {
				const obj = JSON.parse(data);
				const formatted = formatLogLine(obj);
				target.write(formatted);
			} catch {
				target.write(data);
			}
		},
	};
}

// -- Logger Factories --

export function createMcpLogger(serviceName: string): pino.Logger {
	const level = getLogLevel();
	const ecsOpts = buildEcsOptions({ serviceName });

	if (!isProdOrStaging()) {
		// Dev: colorized human-readable output to stderr
		return pino({ level, ...ecsOpts }, createFormattedDestination(2)).child({ service: serviceName });
	}

	// Prod/staging: raw ECS NDJSON to stderr
	return pino({ level, ...ecsOpts }, pino.destination({ dest: 2, sync: true })).child({ service: serviceName });
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
				err: error instanceof Error ? error : new Error(String(error)),
			},
			`Operation failed: ${operation}`,
		);
		throw error;
	}
}
