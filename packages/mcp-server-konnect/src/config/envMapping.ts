// src/config/envMapping.ts

import { configDefaults } from "./defaults.js";

export interface EnvMappingEntry {
	configPath: string;
	envVar: string;
	default: string;
}

/**
 * Explicit mapping from environment variable names to config paths.
 * Each entry documents which env var populates which config field,
 * along with the fallback default value.
 */
export const envMapping: readonly EnvMappingEntry[] = [
	// application
	{ configPath: "application.name", envVar: "APPLICATION_NAME", default: configDefaults.application.name },
	{ configPath: "application.version", envVar: "APPLICATION_VERSION", default: configDefaults.application.version },
	{ configPath: "application.environment", envVar: "NODE_ENV", default: configDefaults.application.environment },
	{ configPath: "application.logLevel", envVar: "LOG_LEVEL", default: configDefaults.application.logLevel },

	// kong
	{ configPath: "kong.accessToken", envVar: "KONNECT_ACCESS_TOKEN", default: "" },
	{ configPath: "kong.region", envVar: "KONNECT_REGION", default: configDefaults.kong.region },
	{ configPath: "kong.baseUrl", envVar: "KONNECT_BASE_URL", default: "" },
	{ configPath: "kong.timeout", envVar: "KONNECT_TIMEOUT", default: configDefaults.kong.timeout },
	{ configPath: "kong.retryAttempts", envVar: "KONNECT_RETRY_ATTEMPTS", default: configDefaults.kong.retryAttempts },
	{ configPath: "kong.retryDelay", envVar: "KONNECT_RETRY_DELAY", default: configDefaults.kong.retryDelay },

	// tracing
	{ configPath: "tracing.enabled", envVar: "LANGSMITH_TRACING", default: configDefaults.tracing.enabled },
	{ configPath: "tracing.apiKey", envVar: "LANGSMITH_API_KEY", default: "" },
	// tracing.project has dual env var lookup (KONNECT_LANGSMITH_PROJECT || LANGSMITH_PROJECT)
	{ configPath: "tracing.project", envVar: "LANGSMITH_PROJECT", default: configDefaults.tracing.project },
	{ configPath: "tracing.endpoint", envVar: "LANGSMITH_ENDPOINT", default: configDefaults.tracing.endpoint },
	{ configPath: "tracing.sessionName", envVar: "LANGSMITH_SESSION", default: configDefaults.tracing.sessionName },
	// tracing.tags uses comma-separated LANGSMITH_TAGS
	{ configPath: "tracing.tags", envVar: "LANGSMITH_TAGS", default: configDefaults.tracing.tags.join(",") },
	{
		configPath: "tracing.samplingRate",
		envVar: "LANGSMITH_SAMPLING_RATE",
		default: configDefaults.tracing.samplingRate,
	},

	// monitoring
	{ configPath: "monitoring.enabled", envVar: "MONITORING_ENABLED", default: configDefaults.monitoring.enabled },
	{
		configPath: "monitoring.healthCheckInterval",
		envVar: "HEALTH_CHECK_INTERVAL",
		default: configDefaults.monitoring.healthCheckInterval,
	},
	{
		configPath: "monitoring.metricsCollection",
		envVar: "METRICS_COLLECTION",
		default: configDefaults.monitoring.metricsCollection,
	},
	{
		configPath: "monitoring.performanceThresholds.responseTimeMs",
		envVar: "PERFORMANCE_RESPONSE_TIME_MS",
		default: configDefaults.monitoring.performanceThresholds.responseTimeMs,
	},
	{
		configPath: "monitoring.performanceThresholds.errorRate",
		envVar: "PERFORMANCE_ERROR_RATE",
		default: configDefaults.monitoring.performanceThresholds.errorRate,
	},

	// runtime
	{ configPath: "runtime.preferBunEnv", envVar: "PREFER_BUN_ENV", default: configDefaults.runtime.preferBunEnv },
	{
		configPath: "runtime.envFileAutoLoad",
		envVar: "ENV_FILE_AUTO_LOAD",
		default: configDefaults.runtime.envFileAutoLoad,
	},
	{ configPath: "runtime.debugMode", envVar: "DEBUG_MODE", default: configDefaults.runtime.debugMode },

	// transport
	{ configPath: "transport.mode", envVar: "MCP_TRANSPORT", default: configDefaults.transport.mode },
	{ configPath: "transport.port", envVar: "MCP_PORT", default: configDefaults.transport.port },
	{ configPath: "transport.host", envVar: "MCP_HOST", default: configDefaults.transport.host },
	{ configPath: "transport.path", envVar: "MCP_PATH", default: configDefaults.transport.path },
	{ configPath: "transport.sessionMode", envVar: "MCP_SESSION_MODE", default: configDefaults.transport.sessionMode },
	{ configPath: "transport.idleTimeout", envVar: "MCP_IDLE_TIMEOUT", default: configDefaults.transport.idleTimeout },
	{ configPath: "transport.apiKey", envVar: "MCP_API_KEY", default: configDefaults.transport.apiKey },
	{
		configPath: "transport.allowedOrigins",
		envVar: "MCP_ALLOWED_ORIGINS",
		default: configDefaults.transport.allowedOrigins,
	},
] as const;
