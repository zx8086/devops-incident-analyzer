// shared/src/tracing/connection-trace.ts
import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { traceable } from "langsmith/traceable";
import type { DataSourceId } from "../datasource.ts";
import { isTracingActive } from "./langsmith.ts";

const tracer = trace.getTracer("mcp-server");

export interface ConnectionContext {
	connectionId: string;
	transportMode: "stdio" | "http" | "both";
	clientInfo?: {
		name?: string;
		version?: string;
		platform?: string;
	};
	sessionId?: string;
}

export function traceConnection<T>(
	context: ConnectionContext,
	handler: () => Promise<T>,
	options: { dataSourceId: DataSourceId },
): Promise<T> {
	let traceName = context.clientInfo?.name || (context.transportMode === "stdio" ? "Claude Desktop" : "Web Client");
	traceName += ` (${context.transportMode.toUpperCase()})`;

	if (context.sessionId) {
		const short = context.sessionId.split("-").pop()?.substring(0, 6) || context.sessionId.substring(0, 8);
		traceName += ` [${short}]`;
	}

	return tracer.startActiveSpan(`mcp.connection.${traceName}`, { kind: SpanKind.SERVER }, async (span: Span) => {
		span.setAttribute("mcp.connection.id", context.connectionId);
		span.setAttribute("mcp.transport.mode", context.transportMode);
		span.setAttribute("mcp.data_source_id", options.dataSourceId);
		if (context.clientInfo?.name) span.setAttribute("mcp.client.name", context.clientInfo.name);

		try {
			const result = await executeConnectionLangSmith(traceName, context, handler, options);
			span.setStatus({ code: SpanStatusCode.OK });
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			span.setStatus({ code: SpanStatusCode.ERROR, message });
			if (error instanceof Error) span.recordException(error);
			throw error;
		} finally {
			span.end();
		}
	});
}

function executeConnectionLangSmith<T>(
	traceName: string,
	context: ConnectionContext,
	handler: () => Promise<T>,
	options: { dataSourceId: DataSourceId },
): Promise<T> {
	if (!isTracingActive()) return handler();

	const traced = traceable(
		async (_input: unknown) => {
			return handler();
		},
		{
			name: traceName,
			run_type: "chain",
			metadata: {
				connection_id: context.connectionId,
				transport_mode: context.transportMode,
				client_name: context.clientInfo?.name || "unknown",
				session_id: context.sessionId,
				data_source_id: options.dataSourceId,
			},
			tags: [
				"mcp-connection",
				`transport:${context.transportMode}`,
				`datasource:${options.dataSourceId}`,
				context.clientInfo?.name ? `client:${context.clientInfo.name}` : "client:unknown",
			],
		},
	);

	return (traced as (...args: unknown[]) => Promise<T>)({
		connectionId: context.connectionId,
		timestamp: new Date().toISOString(),
	});
}
