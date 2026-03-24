// src/utils/mcp-logger.ts
import { createMcpLogger } from "@devops-agent/shared";

export type LogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

export interface LogContext {
	sessionId?: string;
	connectionId?: string;
	clientName?: string;
	operationId?: string;
	toolName?: string;
	[key: string]: unknown;
}

const _logger = createMcpLogger("konnect-mcp-server");

const _childCache = new Map<string, ReturnType<typeof _logger.child>>();

function child(ctx: string) {
	let cached = _childCache.get(ctx);
	if (!cached) {
		cached = _logger.child({ component: ctx });
		_childCache.set(ctx, cached);
	}
	return cached;
}

class MCPLogger {
	setMinLevel(level: LogLevel): void {
		const mapping: Record<string, string> = {
			debug: "debug",
			info: "info",
			notice: "info",
			warning: "warn",
			error: "error",
			critical: "fatal",
			alert: "fatal",
			emergency: "fatal",
		};
		_logger.level = mapping[level] ?? "info";
	}

	setMinLevelFromConfig(configLogLevel: string): void {
		const mapping: Record<string, string> = {
			debug: "debug",
			info: "info",
			warn: "warn",
			error: "error",
		};
		_logger.level = mapping[configLogLevel.toLowerCase()] ?? "info";
	}

	debug(ctx: string, message: string, data?: LogContext): void {
		child(ctx).debug(data ?? {}, message);
	}

	info(ctx: string, message: string, data?: LogContext): void {
		child(ctx).info(data ?? {}, message);
	}

	notice(ctx: string, message: string, data?: LogContext): void {
		child(ctx).info(data ?? {}, message);
	}

	warning(ctx: string, message: string, data?: LogContext): void {
		child(ctx).warn(data ?? {}, message);
	}

	error(ctx: string, message: string, data?: LogContext): void {
		child(ctx).error(data ?? {}, message);
	}

	critical(ctx: string, message: string, data?: LogContext): void {
		child(ctx).fatal(data ?? {}, message);
	}

	alert(ctx: string, message: string, data?: LogContext): void {
		child(ctx).fatal(data ?? {}, message);
	}

	emergency(ctx: string, message: string, data?: LogContext): void {
		child(ctx).fatal(data ?? {}, message);
	}

	startup(ctx: string, data?: LogContext): void {
		child(ctx).info(data ?? {}, "Server starting");
	}

	ready(ctx: string, data?: LogContext): void {
		child(ctx).info(data ?? {}, "Server ready");
	}

	toolCall(ctx: string, toolName: string, data?: LogContext): void {
		child(ctx).debug({ ...data, toolName }, "Tool called");
	}

	operationStart(ctx: string, operation: string, data?: LogContext): void {
		child(ctx).debug({ ...data, operation }, "Operation started");
	}

	operationEnd(ctx: string, operation: string, duration: number, data?: LogContext): void {
		child(ctx).debug({ ...data, operation, duration }, "Operation completed");
	}

	configLoaded(ctx: string, config: Record<string, unknown>): void {
		child(ctx).info(config, "Configuration loaded");
	}

	healthCheck(ctx: string, status: "healthy" | "degraded" | "unhealthy", details?: Record<string, unknown>): void {
		const log = child(ctx);
		if (status === "healthy") log.info(details ?? {}, `Health status: ${status}`);
		else if (status === "degraded") log.warn(details ?? {}, `Health status: ${status}`);
		else log.error(details ?? {}, `Health status: ${status}`);
	}
}

export const mcpLogger = new MCPLogger();

export async function measureOperation<T>(
	loggerName: string,
	operation: string,
	fn: () => Promise<T>,
	context?: LogContext,
): Promise<T> {
	mcpLogger.operationStart(loggerName, operation, context);
	const startTime = Date.now();
	try {
		const result = await fn();
		mcpLogger.operationEnd(loggerName, operation, Date.now() - startTime, context);
		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		mcpLogger.error(loggerName, `Operation failed: ${operation}`, {
			...context,
			operation,
			duration,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export function createContextLogger(loggerName: string, defaultContext?: LogContext) {
	return {
		debug: (msg: string, ctx?: LogContext) => mcpLogger.debug(loggerName, msg, { ...defaultContext, ...ctx }),
		info: (msg: string, ctx?: LogContext) => mcpLogger.info(loggerName, msg, { ...defaultContext, ...ctx }),
		notice: (msg: string, ctx?: LogContext) => mcpLogger.notice(loggerName, msg, { ...defaultContext, ...ctx }),
		warning: (msg: string, ctx?: LogContext) => mcpLogger.warning(loggerName, msg, { ...defaultContext, ...ctx }),
		error: (msg: string, ctx?: LogContext) => mcpLogger.error(loggerName, msg, { ...defaultContext, ...ctx }),
	};
}

export const logger = {
	debug: (message: string, context?: LogContext) => mcpLogger.debug("legacy", message, context),
	info: (message: string, context?: LogContext) => mcpLogger.info("legacy", message, context),
	warn: (message: string, context?: LogContext) => mcpLogger.warning("legacy", message, context),
	error: (message: string, context?: LogContext) => mcpLogger.error("legacy", message, context),
};
