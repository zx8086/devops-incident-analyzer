// observability/src/index.ts
export { getChildLogger, getLogger } from "./logger.ts";
export { getTracer, initOtel, shutdownOtel, traceSpan } from "./otel.ts";
export type { Span } from "./otel.ts";
