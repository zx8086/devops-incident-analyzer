// shared/src/index.ts
export {
	type DataSourceContext,
	DataSourceContextSchema,
	type DataSourceResult,
	DataSourceResultSchema,
	type ExtractedEntities,
	ExtractedEntitiesSchema,
	type StreamEvent,
	StreamEventSchema,
	type ToolError,
	type ToolErrorCategory,
	ToolErrorCategorySchema,
	ToolErrorSchema,
	type ToolOutput,
	ToolOutputSchema,
	type ToolPlanStep,
	ToolPlanStepSchema,
} from "./agent-state.ts";

export { type AgentConfig, AgentConfigSchema, type ServerConfig, ServerConfigSchema } from "./config.ts";

export {
	type CapellaConfig,
	CapellaConfigSchema,
	DATA_SOURCE_IDS,
	type DataSourceId,
	type ElasticDeploymentConfig,
	ElasticDeploymentConfigSchema,
	type KafkaProviderConfig,
	KafkaProviderConfigSchema,
	type KonnectConfig,
	KonnectConfigSchema,
} from "./datasource.ts";

export {
	type SessionContext,
	runWithSession,
	getCurrentSession,
	getCurrentSessionId,
	getCurrentClientInfo,
	createSessionContext,
	initializeTracing,
	isTracingActive,
	getCurrentTrace,
	getTraceable,
	getRunTreeUtils,
	resetTracing,
	type TracingOptions,
	traceToolCall,
	traceToolExecution,
	type ToolTraceOptions,
	traceConnection,
	type ConnectionContext,
	withNestedTrace,
	detectClient,
	generateSessionId,
} from "./tracing/index.ts";
