// src/logging/create-logger.ts

import ecsFormat from "@elastic/ecs-pino-format";
import { trace } from "@opentelemetry/api";
import pino from "pino";
import type { ILogger } from "./ports/logger.port.ts";

interface CreateLoggerOptions {
	level?: string;
	name?: string;
	isDev?: boolean;
}

function wrapPino(instance: pino.Logger): ILogger {
	return {
		debug(message: string, ...args: unknown[]) {
			instance.debug(args.length ? { args } : {}, message);
		},
		info(message: string, ...args: unknown[]) {
			instance.info(args.length ? { args } : {}, message);
		},
		warn(message: string, ...args: unknown[]) {
			instance.warn(args.length ? { args } : {}, message);
		},
		error(message: string, ...args: unknown[]) {
			instance.error(args.length ? { args } : {}, message);
		},
		child(bindings: Record<string, unknown>): ILogger {
			return wrapPino(instance.child(bindings));
		},
		flush() {
			return instance.flush();
		},
		reinitialize(options?: Record<string, unknown>) {
			const newLevel = options?.level;
			if (typeof newLevel === "string") {
				instance.level = newLevel;
			}
		},
	};
}

export function createLogger(options?: CreateLoggerOptions): ILogger {
	const level = options?.level ?? "info";
	const name = options?.name ?? "kafka-mcp-server";
	const isDev = options?.isDev ?? false;

	if (isDev) {
		let transport: pino.TransportSingleOptions | undefined;

		try {
			// Verify pino-pretty is resolvable before configuring transport
			require.resolve("pino-pretty");
			transport = {
				target: "pino-pretty",
				options: { colorize: true, destination: 2 },
			};
		} catch {
			// pino-pretty not installed -- fall back to plain stderr
		}

		const instance = transport
			? pino({ level, name, transport })
			: pino({ level, name }, pino.destination({ dest: 2, sync: false }));

		return wrapPino(instance);
	}

	// Production: ECS-compliant NDJSON to stderr with trace correlation
	const ecsOptions = ecsFormat();
	const instance = pino(
		{
			...ecsOptions,
			level,
			name,
			mixin() {
				const span = trace.getActiveSpan();
				if (!span) return {};
				const { traceId, spanId } = span.spanContext();
				return { "trace.id": traceId, "span.id": spanId };
			},
		},
		pino.destination({ dest: 2, sync: false }),
	);

	return wrapPino(instance);
}
