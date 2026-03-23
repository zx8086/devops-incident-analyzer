// src/utils/tool-tracer.ts
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { traceToolCall } from "./tracing.js";

const SENSITIVE_PARAMS = new Set([
	"cert",
	"certificate",
	"key",
	"privateKey",
	"private_key",
	"certAlt",
	"keyAlt",
	"secret",
	"token",
	"password",
	"apiKey",
	"api_key",
]);

function sanitizeParameters(args: Record<string, unknown>): Record<string, unknown> {
	if (!args || typeof args !== "object") return args;
	const sanitized = { ...args };
	for (const param of SENSITIVE_PARAMS) {
		if (param in sanitized) {
			sanitized[param] = "[REDACTED]";
		}
	}
	return sanitized;
}

export function createTracedToolHandler(
	originalHandler: (args: Record<string, unknown>, extra: RequestHandlerExtra<any, any>) => Promise<unknown>,
	toolName: string,
) {
	return async (args: Record<string, unknown>, extra: RequestHandlerExtra<any, any>) => {
		return traceToolCall(toolName, () => originalHandler(args, extra), {
			toolArgs: sanitizeParameters(args),
		});
	};
}

export class ToolPerformanceCollector {
	private metrics = new Map<
		string,
		{
			callCount: number;
			totalDuration: number;
			errorCount: number;
			lastCalled: string;
		}
	>();

	recordToolExecution(toolName: string, duration: number, success: boolean) {
		const existing = this.metrics.get(toolName) || {
			callCount: 0,
			totalDuration: 0,
			errorCount: 0,
			lastCalled: "",
		};
		existing.callCount++;
		existing.totalDuration += duration;
		existing.lastCalled = new Date().toISOString();
		if (!success) existing.errorCount++;
		this.metrics.set(toolName, existing);
	}

	getToolStats(toolName: string) {
		const stats = this.metrics.get(toolName);
		if (!stats) return null;
		return {
			...stats,
			averageDuration: stats.totalDuration / stats.callCount,
			successRate: (stats.callCount - stats.errorCount) / stats.callCount,
			errorRate: stats.errorCount / stats.callCount,
		};
	}

	getAllStats() {
		const result: Record<string, unknown> = {};
		for (const [toolName, stats] of this.metrics) {
			result[toolName] = {
				...stats,
				averageDuration: stats.totalDuration / stats.callCount,
				successRate: (stats.callCount - stats.errorCount) / stats.callCount,
				errorRate: stats.errorCount / stats.callCount,
			};
		}
		return result;
	}

	reset() {
		this.metrics.clear();
	}
}
