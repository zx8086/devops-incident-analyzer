// observability/src/index.ts
export { getChildLogger, getLogger } from "./logger.ts";
export type { Span } from "./otel.ts";
export { getTracer, initOtel, SpanKind, SpanStatusCode, shutdownOtel, trace, traceSpan } from "./otel.ts";
