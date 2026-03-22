// src/telemetry/tracing.ts
import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

export const tracer = trace.getTracer("kafka-mcp-server");

export async function traceToolExecution<T>(toolName: string, handler: () => Promise<T>): Promise<T> {
	return tracer.startActiveSpan(`mcp.tool.${toolName}`, { kind: SpanKind.SERVER }, async (span: Span) => {
		span.setAttribute("mcp.tool.name", toolName);
		span.setAttribute("mcp.tool.timestamp", Date.now());

		try {
			const result = await handler();
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
