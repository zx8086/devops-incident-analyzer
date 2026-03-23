// shared/src/tracing/tool-trace.ts
import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { traceable } from "langsmith/traceable";
import type { DataSourceId } from "../datasource.ts";
import { isTracingActive } from "./langsmith.ts";
import { getCurrentSession } from "./session.ts";

const tracer = trace.getTracer("mcp-server");

export interface ToolTraceOptions {
	dataSourceId: DataSourceId;
	toolArgs?: Record<string, unknown>;
}

export function traceToolCall<T>(toolName: string, handler: () => Promise<T>, options: ToolTraceOptions): Promise<T> {
	return tracer.startActiveSpan(`mcp.tool.${toolName}`, { kind: SpanKind.SERVER }, async (span: Span) => {
		span.setAttribute("mcp.tool.name", toolName);
		span.setAttribute("mcp.tool.timestamp", Date.now());
		span.setAttribute("mcp.data_source_id", options.dataSourceId);

		try {
			const result = await executeLangSmith(toolName, handler, options);
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

function executeLangSmith<T>(toolName: string, handler: () => Promise<T>, options: ToolTraceOptions): Promise<T> {
	if (!isTracingActive()) return handler();

	const session = getCurrentSession();
	const sessionId = session?.sessionId || "unknown";
	const connectionId = session?.connectionId || "unknown";
	const clientName = session?.clientInfo?.name || "unknown";
	const transportMode = session?.transportMode || "unknown";
	const project = process.env.LANGSMITH_PROJECT;

	const traced = traceable(
		async (_input: unknown) => {
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
				data_source_id: options.dataSourceId,
				session_id: sessionId,
				connection_id: connectionId,
				client_name: clientName,
			},
			tags: [
				"mcp-tool",
				`tool:${toolName}`,
				`datasource:${options.dataSourceId}`,
				`client:${clientName.toLowerCase().replace(/\s+/g, "-")}`,
				`transport:${transportMode}`,
			],
		},
	);

	return (traced as (...args: unknown[]) => Promise<T>)({
		tool_name: toolName,
		arguments: options.toolArgs || {},
		timestamp: new Date().toISOString(),
	});
}

// Backward-compatible alias
export { traceToolCall as traceToolExecution };
