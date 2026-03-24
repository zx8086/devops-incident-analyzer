// shared/src/telemetry/pino-exporters.ts
// Custom OTel exporters that route through Pino ECS logger to stderr
// instead of dumping raw JSON to stdout like the default Console*Exporters.

import { SpanKind } from "@opentelemetry/api";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { createMcpLogger } from "../logger.ts";

const logger = createMcpLogger("otel");

const SPAN_KIND_NAMES: Record<number, string> = {
	[SpanKind.INTERNAL]: "INTERNAL",
	[SpanKind.SERVER]: "SERVER",
	[SpanKind.CLIENT]: "CLIENT",
	[SpanKind.PRODUCER]: "PRODUCER",
	[SpanKind.CONSUMER]: "CONSUMER",
};

function hrTimeToMs(hrTime: [number, number]): number {
	return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

// Matches ExportResultCode.SUCCESS from @opentelemetry/core without importing it
const EXPORT_SUCCESS = { code: 0 as const };

export class PinoSpanExporter implements SpanExporter {
	export(spans: ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
		for (const span of spans) {
			const durationMs = hrTimeToMs(span.duration);
			const isError = span.status.code === 2;

			const logData: Record<string, unknown> = {
				"trace.id": span.spanContext().traceId,
				"span.id": span.spanContext().spanId,
				"span.name": span.name,
				"span.kind": SPAN_KIND_NAMES[span.kind] ?? span.kind,
				"span.duration_ms": Math.round(durationMs * 100) / 100,
				"span.scope": span.instrumentationScope.name,
			};

			if (span.parentSpanContext) {
				logData["span.parent_id"] = span.parentSpanContext.spanId;
			}

			for (const [key, value] of Object.entries(span.attributes)) {
				if (value !== undefined) {
					logData[`otel.${key}`] = value;
				}
			}

			if (isError && span.status.message) {
				logData["span.status"] = "ERROR";
				logData["span.error"] = span.status.message;
			}

			const msg = `${span.name} (${Math.round(durationMs)}ms)`;

			if (isError) {
				logger.error(logData, msg);
			} else {
				logger.debug(logData, msg);
			}
		}

		resultCallback(EXPORT_SUCCESS);
	}

	async shutdown(): Promise<void> {}
	async forceFlush(): Promise<void> {}
}

export class PinoMetricExporter implements PushMetricExporter {
	export(metrics: ResourceMetrics, resultCallback: (result: { code: number }) => void): void {
		for (const scopeMetrics of metrics.scopeMetrics) {
			for (const metric of scopeMetrics.metrics) {
				if (metric.dataPoints.length === 0) continue;

				for (const point of metric.dataPoints) {
					const value = typeof point.value === "number" ? point.value : JSON.stringify(point.value);
					logger.debug(
						{
							"metric.name": metric.descriptor.name,
							"metric.unit": metric.descriptor.unit || undefined,
							"metric.value": value,
							"metric.scope": scopeMetrics.scope.name,
						},
						`${metric.descriptor.name}: ${value}`,
					);
				}
			}
		}

		resultCallback(EXPORT_SUCCESS);
	}

	async shutdown(): Promise<void> {}
	async forceFlush(): Promise<void> {}

	selectAggregationTemporality() {
		return 0;
	}

	selectAggregation() {
		return undefined as never;
	}
}

export class PinoLogRecordExporter implements LogRecordExporter {
	export(logs: ReadableLogRecord[], resultCallback: (result: { code: number }) => void): void {
		for (const record of logs) {
			const body = record.body;
			const msg = typeof body === "string" ? body : JSON.stringify(body);

			logger.debug(
				{
					"log.scope": record.instrumentationScope.name,
					"log.severity": record.severityText ?? undefined,
				},
				msg || "OTel log record",
			);
		}

		resultCallback(EXPORT_SUCCESS);
	}

	async shutdown(): Promise<void> {}
	async forceFlush(): Promise<void> {}
}
