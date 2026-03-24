// shared/src/telemetry/telemetry.ts

import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import { BatchLogRecordProcessor, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PinoLogRecordExporter, PinoMetricExporter, PinoSpanExporter } from "./pino-exporters.ts";

export interface TelemetryConfig {
	enabled: boolean;
	serviceName: string;
	mode: "console" | "otlp" | "both";
	otlpEndpoint: string;
}

function buildExporters(config: TelemetryConfig): {
	spanProcessors: BatchSpanProcessor[];
	metricReaders: PeriodicExportingMetricReader[];
	logRecordProcessors: LogRecordProcessor[];
} {
	const spanExporters: SpanExporter[] = [];
	const metricExporters: PushMetricExporter[] = [];
	const logExporters: LogRecordExporter[] = [];

	if (config.mode === "console" || config.mode === "both") {
		spanExporters.push(new PinoSpanExporter());
		metricExporters.push(new PinoMetricExporter());
		logExporters.push(new PinoLogRecordExporter());
	}

	if (config.mode === "otlp" || config.mode === "both") {
		spanExporters.push(new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` }));
		metricExporters.push(new OTLPMetricExporter({ url: `${config.otlpEndpoint}/v1/metrics` }));
		logExporters.push(new OTLPLogExporter({ url: `${config.otlpEndpoint}/v1/logs` }));
	}

	return {
		spanProcessors: spanExporters.map((exporter) => new BatchSpanProcessor(exporter)),
		metricReaders: metricExporters.map((exporter) => new PeriodicExportingMetricReader({ exporter })),
		logRecordProcessors: logExporters.map((exporter) => new BatchLogRecordProcessor(exporter)),
	};
}

export function initTelemetry(config: TelemetryConfig): NodeSDK | null {
	if (!config.enabled) {
		return null;
	}

	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: config.serviceName,
	});

	const { spanProcessors, metricReaders, logRecordProcessors } = buildExporters(config);

	const sdk = new NodeSDK({
		resource,
		spanProcessors,
		metricReaders,
		logRecordProcessors,
	});

	sdk.start();

	return sdk;
}

export async function shutdownTelemetry(sdk: NodeSDK | null): Promise<void> {
	if (sdk) {
		await sdk.shutdown();
	}
}

// -- Tracing Utilities --

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

export function buildTelemetryConfig(serviceName: string): TelemetryConfig {
	return {
		enabled: process.env.TELEMETRY_MODE !== undefined,
		serviceName,
		mode: (process.env.TELEMETRY_MODE as "console" | "otlp" | "both") || "otlp",
		otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
	};
}
