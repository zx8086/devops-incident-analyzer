// shared/src/tracing/index.ts
export {
	type SessionContext,
	runWithSession,
	getCurrentSession,
	getCurrentSessionId,
	getCurrentClientInfo,
	createSessionContext,
} from "./session.ts";

export {
	initializeTracing,
	isTracingActive,
	getCurrentTrace,
	getTraceable,
	getRunTreeUtils,
	resetTracing,
	type TracingOptions,
} from "./langsmith.ts";

export { traceToolCall, traceToolExecution, type ToolTraceOptions } from "./tool-trace.ts";

export { traceConnection, type ConnectionContext } from "./connection-trace.ts";

export { withNestedTrace } from "./nested-trace.ts";

export { detectClient, generateSessionId } from "./client-detect.ts";

export { withExtractedContext, withTraceContextMiddleware } from "./context-propagation.ts";
