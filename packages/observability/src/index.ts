// observability/src/index.ts

export { getCurrentRequestContext, type RequestContext, runWithRequestContext } from "@devops-agent/shared";
export { getChildLogger, getLogger } from "./logger.ts";
export type { Span } from "./otel.ts";
export { getTracer, initOtel, SpanKind, SpanStatusCode, shutdownOtel, trace, traceSpan } from "./otel.ts";
