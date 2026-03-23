// src/utils/tracing.ts
import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { logger } from "../lib/logger";
import { getCurrentSession } from "./sessionContext";

export const tracer = trace.getTracer("couchbase-mcp-server");

let isTracingEnabled = false;
let isInitialized = false;
let traceable: ((fn: (...args: unknown[]) => unknown, config: Record<string, unknown>) => unknown) | null = null;

export function initializeTracing(): void {
	if (isInitialized) return;
	isInitialized = true;

	const enabled = process.env.LANGSMITH_TRACING === "true" || process.env.LANGCHAIN_TRACING_V2 === "true";
	const apiKey = process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY;

	if (!enabled || !apiKey) {
		logger.info("LangSmith tracing disabled for Couchbase MCP server");
		return;
	}

	const project = process.env.COUCHBASE_LANGSMITH_PROJECT || process.env.LANGSMITH_PROJECT || "couchbase-mcp-server";
	const endpoint = process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com";

	process.env.LANGSMITH_TRACING = "true";
	process.env.LANGCHAIN_TRACING_V2 = "true";
	process.env.LANGSMITH_API_KEY = apiKey;
	process.env.LANGCHAIN_API_KEY = apiKey;
	process.env.LANGSMITH_PROJECT = project;
	process.env.LANGCHAIN_PROJECT = project;
	process.env.LANGSMITH_ENDPOINT = endpoint;
	process.env.LANGCHAIN_ENDPOINT = endpoint;

	try {
		const mod = require("langsmith/traceable");
		traceable = mod.traceable;
		isTracingEnabled = true;
		logger.info("LangSmith tracing initialized", { endpoint, project });
	} catch (error) {
		logger.warn("Failed to import langsmith/traceable, LangSmith tracing disabled", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function isTracingActive(): boolean {
	return isTracingEnabled;
}

export function traceToolCall<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
	return tracer.startActiveSpan(`mcp.tool.${toolName}`, { kind: SpanKind.SERVER }, async (span: Span) => {
		span.setAttribute("mcp.tool.name", toolName);
		span.setAttribute("mcp.tool.timestamp", Date.now());

		const execute = isTracingEnabled && traceable ? wrapWithLangSmith(toolName, handler) : handler;

		try {
			const result = await execute();
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			span.setStatus({ code: SpanStatusCode.ERROR, message });
			if (error instanceof Error) {
				span.recordException(error);
			}
			throw error;
		} finally {
			span.end();
		}
	});
}

function wrapWithLangSmith<T>(toolName: string, handler: () => Promise<T>): () => Promise<T> {
	if (!traceable) return handler;

	const session = getCurrentSession();
	const sessionId = session?.sessionId || "unknown";
	const connectionId = session?.connectionId || "unknown";
	const clientName = session?.clientInfo?.name || "unknown";
	const project = process.env.LANGSMITH_PROJECT || "couchbase-mcp-server";

	const traced = traceable(
		async () => {
			const startTime = Date.now();
			const result = await handler();
			return {
				...(typeof result === "object" && result !== null ? result : { result }),
				_trace: { executionTime: Date.now() - startTime, project },
			};
		},
		{
			name: toolName,
			run_type: "tool",
			project_name: project,
			metadata: {
				tool_name: toolName,
				data_source_id: "couchbase",
				session_id: sessionId,
				connection_id: connectionId,
				client_name: clientName,
			},
			tags: ["mcp-tool", `tool:${toolName}`, `client:${clientName.toLowerCase().replace(/\s+/g, "-")}`],
		},
	) as () => Promise<T>;

	return traced;
}
