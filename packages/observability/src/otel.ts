// observability/src/otel.ts
import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

let sdk: NodeSDK | null = null;

export function initOtel(serviceName: string): NodeSDK | null {
	const mode = process.env.TELEMETRY_MODE as "console" | "otlp" | "both" | undefined;
	if (!mode) return null;

	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
	const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });
	const spanProcessors = [];

	if (mode === "console" || mode === "both") {
		spanProcessors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
	}
	if (mode === "otlp" || mode === "both") {
		spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })));
	}

	sdk = new NodeSDK({ resource, spanProcessors });
	sdk.start();
	return sdk;
}

export async function shutdownOtel(): Promise<void> {
	if (sdk) await sdk.shutdown();
}

export function getTracer(name: string) {
	return trace.getTracer(name);
}

export function traceSpan<T>(
	tracerName: string,
	spanName: string,
	fn: (span: Span) => Promise<T>,
	attributes?: Record<string, string | number>,
): Promise<T> {
	const tracer = trace.getTracer(tracerName);
	return tracer.startActiveSpan(spanName, { kind: SpanKind.INTERNAL }, async (span: Span) => {
		if (attributes) {
			for (const [key, value] of Object.entries(attributes)) {
				span.setAttribute(key, value);
			}
		}
		try {
			const result = await fn(span);
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

export { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
export type { Span } from "@opentelemetry/api";
