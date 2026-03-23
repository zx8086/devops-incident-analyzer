// observability/src/index.ts
export { getChildLogger, getLogger } from "./logger.ts";
export type { Span } from "./otel.ts";
export { getTracer, initOtel, shutdownOtel, traceSpan } from "./otel.ts";
