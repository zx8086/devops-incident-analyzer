// shared/src/tracing/index.ts

export { detectClient, generateSessionId } from "./client-detect.ts";
export { type ConnectionContext, traceConnection } from "./connection-trace.ts";
export { withExtractedContext, withTraceContextMiddleware } from "./context-propagation.ts";
export {
	getCurrentTrace,
	getRunTreeUtils,
	getTraceable,
	initializeTracing,
	isTracingActive,
	resetTracing,
	type TracingOptions,
} from "./langsmith.ts";

export { withNestedTrace } from "./nested-trace.ts";
export {
	createSessionContext,
	getCurrentClientInfo,
	getCurrentSession,
	getCurrentSessionId,
	runWithSession,
	type SessionContext,
} from "./session.ts";
export { type ToolTraceOptions, traceToolCall } from "./tool-trace.ts";
