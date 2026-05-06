// src/config/schemas.ts
import { z } from "zod";

export const ServerConfigSchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	readOnlyMode: z.boolean(),
	readOnlyStrictMode: z.boolean(),
	maxQueryTimeout: z.number().min(1000).max(300000),
	maxResultsPerQuery: z.number().min(1).max(10000),
	transportMode: z.enum(["stdio", "http", "both", "agentcore"]),
	port: z.number(),
	host: z.string(),
	path: z.string().startsWith("/"),
	sessionMode: z.enum(["stateless", "stateful"]),
	idleTimeout: z.number().int().min(10).max(255),
	apiKey: z.string().optional(),
	allowedOrigins: z.string().optional(),
	// Enhanced response handling configuration
	maxResponseSizeBytes: z.number().min(1000).max(10000000),
	defaultPageSize: z.number().min(1).max(1000),
	maxPageSize: z.number().min(10).max(10000),
	enableResponseCompression: z.boolean(),
	autoSummarizeLargeResponses: z.boolean(),
	// Monitoring configuration
	monitoringPort: z.number().min(1024).max(65535),
});

// SIO-649: Per-deployment connection config. Auth is apiKey OR username+password (XOR) OR none (local dev).
export const DeploymentConfigSchema = z
	.object({
		id: z.string().min(1),
		url: z.string().url().min(1),
		apiKey: z.string().optional(),
		username: z.string().optional(),
		password: z.string().optional(),
		caCert: z.string().optional(),
	})
	.refine(
		(data) => {
			if (data.username) return !!data.password;
			if (data.password) return !!data.username;
			return true;
		},
		{
			message: "Deployment auth requires apiKey, or both username+password, or neither",
			path: ["username", "password"],
		},
	);

export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;

export const ElasticsearchConfigSchema = z
	.object({
		url: z.string().url().min(1),
		apiKey: z.string().optional(),
		username: z.string().optional(),
		password: z.string().optional(),
		caCert: z.string().optional(),
		maxRetries: z.number().min(0).max(10),
		requestTimeout: z.number().min(1000).max(60000),
		compression: z.boolean(),
		enableMetaHeader: z.boolean(),
		disablePrototypePoisoningProtection: z.boolean(),
		// SIO-649: When populated, server runs in multi-deployment mode; `url`/`apiKey`/etc above
		// describe the default deployment (kept for legacy single-deployment env vars).
		deployments: z.array(DeploymentConfigSchema).optional(),
		defaultDeploymentId: z.string().optional(),
	})
	.refine(
		(data) => {
			// If username is provided, password must be provided
			if (data.username) {
				return !!data.password;
			}

			// If password is provided, username must be provided
			if (data.password) {
				return !!data.username;
			}

			// If apiKey is provided, it's valid
			if (data.apiKey) {
				return true;
			}

			// No auth is also valid (for local development)
			return true;
		},
		{
			message:
				"Either ES_API_KEY or both ES_USERNAME and ES_PASSWORD must be provided, or no auth for local development",
			path: ["username", "password"],
		},
	)
	.refine(
		(data) => {
			if (!data.deployments || data.deployments.length === 0) return true;
			if (!data.defaultDeploymentId) return true;
			return data.deployments.some((d) => d.id === data.defaultDeploymentId);
		},
		{
			message: "defaultDeploymentId must match one of the configured deployments",
			path: ["defaultDeploymentId"],
		},
	);

export const LoggingConfigSchema = z.object({
	level: z.enum(["debug", "info", "warn", "error"]),
	format: z.enum(["json", "text"]),
	includeMetadata: z.boolean(),
});

export const SecurityConfigSchema = z.object({
	allowDestructiveOperations: z.boolean(),
	allowSchemaModifications: z.boolean(),
	allowIndexManagement: z.boolean(),
	maxBulkOperations: z.number().min(1).max(10000),
});

export const LangSmithConfigSchema = z.object({
	tracing: z.boolean(),
	endpoint: z.string().url(),
	apiKey: z.string().optional(),
	project: z.string(),
});

export const SessionTrackingConfigSchema = z.object({
	enabled: z.boolean(),
	sessionTimeoutMinutes: z.number().min(0.5).max(120),
	includeSessionInTraceName: z.boolean(),
	maxConcurrentSessions: z.number().min(10).max(1000),
	conversationDetectionThresholdSeconds: z.number().min(10).max(300),
});

// SIO-674: Elastic Cloud organisation-scoped API config (https://api.elastic-cloud.com).
// Distinct from cluster API auth -- needs its own ApiKey credential. Optional on the parent
// schema so self-hosted ES users don't need EC_API_KEY to boot.
export const ElasticCloudConfigSchema = z.object({
	apiKey: z.string().min(1),
	endpoint: z.string().url(),
	defaultOrgId: z.string().optional(),
	requestTimeout: z.number().min(1000).max(60000),
	maxRetries: z.number().min(0).max(10),
});

export type ElasticCloudConfig = z.infer<typeof ElasticCloudConfigSchema>;

export const ConfigSchema = z.object({
	server: ServerConfigSchema,
	elasticsearch: ElasticsearchConfigSchema,
	logging: LoggingConfigSchema,
	security: SecurityConfigSchema,
	langsmith: LangSmithConfigSchema,
	sessionTracking: SessionTrackingConfigSchema,
	cloud: ElasticCloudConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
