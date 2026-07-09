// shared/src/logger.ts
import ecsFormat from "@elastic/ecs-pino-format";
import { trace } from "@opentelemetry/api";
import pino from "pino";
import { getCurrentRequestContext } from "./request-context.ts";
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

export function buildEcsOptions(config: EcsLoggerConfig & { retentionPeriod?: string }): pino.LoggerOptions {
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

	const retentionPeriod = config.retentionPeriod;

	return {
		...ecsOptions,
		mixin() {
			const fields: Record<string, string> = {};

			// SIO-637: Inject retention expiry so downstream systems can enforce TTL
			if (retentionPeriod) {
				const { getRetentionExpiresAt } = require("./retention.ts");
				fields._retention_expires_at = getRetentionExpiresAt(retentionPeriod);
			}

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

			// Chat request correlation (SIO-779)
			const reqCtx = getCurrentRequestContext();
			if (reqCtx) {
				fields.threadId = reqCtx.threadId;
				fields.runId = reqCtx.runId;
				fields.requestId = reqCtx.requestId;
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

export interface McpLoggerOptions {
	immutableChain?: boolean;
	retentionPeriod?: string;
}

// SIO-1041: minimum SonicBoom coalescing buffer before a flush syscall in prod/staging. Bounds
// write() syscalls under bursty load; the exit hook + 5s timer bound worst-case latency.
const PROD_LOG_MIN_LENGTH = 4096;
const PROD_LOG_FLUSH_INTERVAL_MS = 5_000;

interface SonicBoomLike {
	flush(): void;
	flushSync(): void;
}

// Registry-guard the process-level exit hook so multiple createMcpLogger calls in ONE process
// (the knowledge-graph server is mounted in-process in the web app) register a SINGLE exit
// handler that flushes ALL registered SonicBoom destinations, instead of N stacked handlers.
const prodDestinations = new Set<SonicBoomLike>();
let exitHookInstalled = false;

function registerProdDestination(sonic: SonicBoomLike): void {
	prodDestinations.add(sonic);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		// 'exit' fires synchronously even on process.exit() from bootstrap fatal paths, so this is
		// the real flush guarantee (bootstrap's logger.flush?.() is async and can race the exit).
		process.on("exit", () => {
			for (const dest of prodDestinations) {
				try {
					dest.flushSync();
				} catch {
					// A destination already closed/errored must not block the others from flushing.
				}
			}
		});
	}
}

// SIO-1041: async (sync:false) prod/staging destination on fd 2 with bounded worst-case latency.
// Returns the raw SonicBoom so the exit hook + interval flush target it directly -- NOT any
// immutableChain wrapper, which only wraps write() and writes through to this SonicBoom.
export function createProdDestination(fd: 1 | 2): SonicBoomLike {
	const sonic = pino.destination({ dest: fd, sync: false, minLength: PROD_LOG_MIN_LENGTH }) as unknown as SonicBoomLike;
	registerProdDestination(sonic);
	// Bound latency on quiet servers where minLength is never reached. unref'd so the timer never
	// keeps the process alive on its own.
	const flushTimer = setInterval(() => sonic.flush(), PROD_LOG_FLUSH_INTERVAL_MS);
	flushTimer.unref();
	return sonic;
}

export function createMcpLogger(serviceName: string, options?: McpLoggerOptions): pino.Logger {
	const level = getLogLevel();
	const ecsConfig: EcsLoggerConfig & { retentionPeriod?: string } = { serviceName };
	if (options?.retentionPeriod) ecsConfig.retentionPeriod = options.retentionPeriod;
	const ecsOpts = buildEcsOptions(ecsConfig);

	if (!isProdOrStaging()) {
		let dest: { write(data: string): void } = createFormattedDestination(2);
		if (options?.immutableChain) {
			const { createHashChainDestination } = require("./immutable-log.ts");
			dest = createHashChainDestination(dest);
		}
		return pino({ level, ...ecsOpts }, dest).child({ service: serviceName });
	}

	// SIO-1041: async destination (was sync:true, a blocking write() syscall per log line in the
	// server hot path). dest stays fd 2 for stdio-protocol safety. The exit hook + 5s interval
	// flush installed by createProdDestination bound worst-case latency.
	const sonic = createProdDestination(2);
	let dest: { write(data: string): void } = sonic as unknown as { write(data: string): void };
	if (options?.immutableChain) {
		const { createHashChainDestination } = require("./immutable-log.ts");
		// The hash-chain wraps write() only and writes THROUGH to sonic; flushSync/flush still
		// target the SonicBoom directly (registered above), never this wrapper.
		dest = createHashChainDestination(dest);
	}
	return pino({ level, ...ecsOpts }, dest).child({ service: serviceName });
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
