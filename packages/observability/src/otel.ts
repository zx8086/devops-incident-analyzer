// observability/src/otel.ts
import { buildTelemetryConfig, getTracer, initTelemetry, shutdownTelemetry, traceSpan } from "@devops-agent/shared";

let sdk: ReturnType<typeof initTelemetry> = null;

export function initOtel(serviceName: string): ReturnType<typeof initTelemetry> {
	const config = buildTelemetryConfig(serviceName);
	sdk = initTelemetry(config);
	return sdk;
}

export async function shutdownOtel(): Promise<void> {
	await shutdownTelemetry(sdk);
}

export type { Span } from "@opentelemetry/api";
export { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
export { getTracer, traceSpan };
