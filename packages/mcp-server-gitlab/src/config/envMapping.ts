// src/config/envMapping.ts

import { configDefaults } from "./defaults.js";

export interface EnvMappingEntry {
	configPath: string;
	envVar: string;
	default: string;
}

export const envMapping: readonly EnvMappingEntry[] = [
	// application
	{ configPath: "application.name", envVar: "APPLICATION_NAME", default: configDefaults.application.name },
	{ configPath: "application.version", envVar: "APPLICATION_VERSION", default: configDefaults.application.version },
	{ configPath: "application.environment", envVar: "NODE_ENV", default: configDefaults.application.environment },
	{ configPath: "application.logLevel", envVar: "LOG_LEVEL", default: configDefaults.application.logLevel },

	// gitlab
	{ configPath: "gitlab.instanceUrl", envVar: "GITLAB_INSTANCE_URL", default: configDefaults.gitlab.instanceUrl },
	{ configPath: "gitlab.personalAccessToken", envVar: "GITLAB_PERSONAL_ACCESS_TOKEN", default: "" },
	{ configPath: "gitlab.defaultProjectId", envVar: "GITLAB_DEFAULT_PROJECT_ID", default: "" },
	{ configPath: "gitlab.timeout", envVar: "GITLAB_TIMEOUT", default: configDefaults.gitlab.timeout },
	{ configPath: "gitlab.retryAttempts", envVar: "GITLAB_RETRY_ATTEMPTS", default: configDefaults.gitlab.retryAttempts },
	{ configPath: "gitlab.retryDelay", envVar: "GITLAB_RETRY_DELAY", default: configDefaults.gitlab.retryDelay },
	{
		configPath: "gitlab.oauthCallbackPort",
		envVar: "GITLAB_OAUTH_CALLBACK_PORT",
		default: configDefaults.gitlab.oauthCallbackPort,
	},

	// tracing
	{ configPath: "tracing.enabled", envVar: "LANGSMITH_TRACING", default: configDefaults.tracing.enabled },
	{ configPath: "tracing.apiKey", envVar: "LANGSMITH_API_KEY", default: "" },
	{ configPath: "tracing.project", envVar: "LANGSMITH_PROJECT", default: configDefaults.tracing.project },
	{ configPath: "tracing.endpoint", envVar: "LANGSMITH_ENDPOINT", default: configDefaults.tracing.endpoint },
	{ configPath: "tracing.sessionName", envVar: "LANGSMITH_SESSION", default: configDefaults.tracing.sessionName },
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
