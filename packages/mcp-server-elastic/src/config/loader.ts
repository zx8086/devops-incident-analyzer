// src/config/loader.ts

import { defaultConfig } from "./defaults.js";
import { envVarMapping } from "./envMapping.js";
import type { Config } from "./schemas.js";
import { ConfigSchema } from "./schemas.js";

function parseEnvVar(value: string | undefined, type: "string" | "number" | "boolean"): unknown {
	if (value === undefined) return undefined;
	if (type === "number") return Number(value);
	if (type === "boolean") return value.toLowerCase() === "true";
	return value;
}

function loadConfigFromEnv(): Partial<Config> {
	const config: Partial<Config> = {};

	// Load server config
	config.server = {
		name: (parseEnvVar(Bun.env[envVarMapping.server.name], "string") as string) || defaultConfig.server.name,
		version: (parseEnvVar(Bun.env[envVarMapping.server.version], "string") as string) || defaultConfig.server.version,
		readOnlyMode:
			(parseEnvVar(Bun.env[envVarMapping.server.readOnlyMode], "boolean") as boolean) ??
			defaultConfig.server.readOnlyMode,
		readOnlyStrictMode:
			(parseEnvVar(Bun.env[envVarMapping.server.readOnlyStrictMode], "boolean") as boolean) ??
			defaultConfig.server.readOnlyStrictMode,
		maxQueryTimeout:
			(parseEnvVar(Bun.env[envVarMapping.server.maxQueryTimeout], "number") as number) ||
			defaultConfig.server.maxQueryTimeout,
		maxResultsPerQuery:
			(parseEnvVar(Bun.env[envVarMapping.server.maxResultsPerQuery], "number") as number) ||
			defaultConfig.server.maxResultsPerQuery,
		transportMode:
			(parseEnvVar(Bun.env[envVarMapping.server.transportMode], "string") as "stdio" | "http" | "both") ||
			defaultConfig.server.transportMode,
		port: (parseEnvVar(Bun.env[envVarMapping.server.port], "number") as number) || defaultConfig.server.port,
		host: (parseEnvVar(Bun.env[envVarMapping.server.host], "string") as string) || defaultConfig.server.host,
		path: (parseEnvVar(Bun.env[envVarMapping.server.path], "string") as string) || defaultConfig.server.path,
		sessionMode:
			(parseEnvVar(Bun.env[envVarMapping.server.sessionMode], "string") as "stateless" | "stateful") ||
			defaultConfig.server.sessionMode,
		idleTimeout:
			(parseEnvVar(Bun.env[envVarMapping.server.idleTimeout], "number") as number) || defaultConfig.server.idleTimeout,
		apiKey: parseEnvVar(Bun.env[envVarMapping.server.apiKey], "string") as string | undefined,
		allowedOrigins: parseEnvVar(Bun.env[envVarMapping.server.allowedOrigins], "string") as string | undefined,
		maxResponseSizeBytes:
			(parseEnvVar(Bun.env[envVarMapping.server.maxResponseSizeBytes], "number") as number) ||
			defaultConfig.server.maxResponseSizeBytes,
		defaultPageSize:
			(parseEnvVar(Bun.env[envVarMapping.server.defaultPageSize], "number") as number) ||
			defaultConfig.server.defaultPageSize,
		maxPageSize:
			(parseEnvVar(Bun.env[envVarMapping.server.maxPageSize], "number") as number) || defaultConfig.server.maxPageSize,
		enableResponseCompression:
			(parseEnvVar(Bun.env[envVarMapping.server.enableResponseCompression], "boolean") as boolean) ??
			defaultConfig.server.enableResponseCompression,
		autoSummarizeLargeResponses:
			(parseEnvVar(Bun.env[envVarMapping.server.autoSummarizeLargeResponses], "boolean") as boolean) ??
			defaultConfig.server.autoSummarizeLargeResponses,
		monitoringPort:
			(parseEnvVar(Bun.env[envVarMapping.server.monitoringPort], "number") as number) ||
			defaultConfig.server.monitoringPort,
	};

	// Load elasticsearch config
	config.elasticsearch = {
		url: (parseEnvVar(Bun.env[envVarMapping.elasticsearch.url], "string") as string) || defaultConfig.elasticsearch.url,
		apiKey: parseEnvVar(Bun.env[envVarMapping.elasticsearch.apiKey], "string") as string,
		username: parseEnvVar(Bun.env[envVarMapping.elasticsearch.username], "string") as string,
		password: parseEnvVar(Bun.env[envVarMapping.elasticsearch.password], "string") as string,
		caCert: parseEnvVar(Bun.env[envVarMapping.elasticsearch.caCert], "string") as string,
		maxRetries:
			(parseEnvVar(Bun.env[envVarMapping.elasticsearch.maxRetries], "number") as number) ||
			defaultConfig.elasticsearch.maxRetries,
		requestTimeout:
			(parseEnvVar(Bun.env[envVarMapping.elasticsearch.requestTimeout], "number") as number) ||
			defaultConfig.elasticsearch.requestTimeout,
		compression:
			(parseEnvVar(Bun.env[envVarMapping.elasticsearch.compression], "boolean") as boolean) ??
			defaultConfig.elasticsearch.compression,
		enableMetaHeader:
			(parseEnvVar(Bun.env[envVarMapping.elasticsearch.enableMetaHeader], "boolean") as boolean) ??
			defaultConfig.elasticsearch.enableMetaHeader,
		disablePrototypePoisoningProtection:
			(parseEnvVar(Bun.env[envVarMapping.elasticsearch.disablePrototypePoisoningProtection], "boolean") as boolean) ??
			defaultConfig.elasticsearch.disablePrototypePoisoningProtection,
	};

	// Load logging config
	config.logging = {
		level:
			(parseEnvVar(Bun.env[envVarMapping.logging.level], "string") as "debug" | "info" | "warn" | "error") ||
			defaultConfig.logging.level,
		format:
			(parseEnvVar(Bun.env[envVarMapping.logging.format], "string") as "json" | "text") || defaultConfig.logging.format,
		includeMetadata:
			(parseEnvVar(Bun.env[envVarMapping.logging.includeMetadata], "boolean") as boolean) ??
			defaultConfig.logging.includeMetadata,
	};

	// Load security config
	config.security = {
		allowDestructiveOperations:
			(parseEnvVar(Bun.env[envVarMapping.security.allowDestructiveOperations], "boolean") as boolean) ??
			defaultConfig.security.allowDestructiveOperations,
		allowSchemaModifications:
			(parseEnvVar(Bun.env[envVarMapping.security.allowSchemaModifications], "boolean") as boolean) ??
			defaultConfig.security.allowSchemaModifications,
		allowIndexManagement:
			(parseEnvVar(Bun.env[envVarMapping.security.allowIndexManagement], "boolean") as boolean) ??
			defaultConfig.security.allowIndexManagement,
		maxBulkOperations:
			(parseEnvVar(Bun.env[envVarMapping.security.maxBulkOperations], "number") as number) ||
			defaultConfig.security.maxBulkOperations,
	};

	// Load LangSmith config (ELASTIC_LANGSMITH_PROJECT -> LANGSMITH_PROJECT -> default)
	config.langsmith = {
		tracing:
			(parseEnvVar(Bun.env[envVarMapping.langsmith.tracing], "boolean") as boolean) ?? defaultConfig.langsmith.tracing,
		endpoint:
			(parseEnvVar(Bun.env[envVarMapping.langsmith.endpoint], "string") as string) || defaultConfig.langsmith.endpoint,
		apiKey: parseEnvVar(Bun.env[envVarMapping.langsmith.apiKey], "string") as string,
		project:
			(parseEnvVar(Bun.env[envVarMapping.langsmith.project], "string") as string) ||
			(parseEnvVar(Bun.env[envVarMapping.langsmith.projectFallback], "string") as string) ||
			defaultConfig.langsmith.project,
	};

	// Load Session Tracking config
	config.sessionTracking = {
		enabled:
			(parseEnvVar(Bun.env[envVarMapping.sessionTracking.enabled], "boolean") as boolean) ??
			defaultConfig.sessionTracking.enabled,
		sessionTimeoutMinutes:
			(parseEnvVar(Bun.env[envVarMapping.sessionTracking.sessionTimeoutMinutes], "number") as number) ||
			defaultConfig.sessionTracking.sessionTimeoutMinutes,
		includeSessionInTraceName:
			(parseEnvVar(Bun.env[envVarMapping.sessionTracking.includeSessionInTraceName], "boolean") as boolean) ??
			defaultConfig.sessionTracking.includeSessionInTraceName,
		maxConcurrentSessions:
			(parseEnvVar(Bun.env[envVarMapping.sessionTracking.maxConcurrentSessions], "number") as number) ||
			defaultConfig.sessionTracking.maxConcurrentSessions,
		conversationDetectionThresholdSeconds:
			(parseEnvVar(Bun.env[envVarMapping.sessionTracking.conversationDetectionThresholdSeconds], "number") as number) ||
			defaultConfig.sessionTracking.conversationDetectionThresholdSeconds,
	};

	return config;
}

export function validateEnvironment(): { valid: boolean; errors: string[]; warnings?: string[] } {
	const requiredVars = ["ES_URL"];
	const errors: string[] = [];
	const warnings: string[] = [];

	for (const varName of requiredVars) {
		if (!Bun.env[varName]) {
			errors.push(`Missing required environment variable: ${varName}`);
		}
	}

	// Check for potential URL format issues
	if (Bun.env.ES_URL) {
		try {
			const url = new URL(Bun.env.ES_URL);
			if (!url.protocol.startsWith("http")) {
				errors.push("ES_URL must use http or https protocol");
			}

			// Check if it's an Elastic Cloud URL
			if (url.hostname.includes(".es.") && url.hostname.includes(".aws.cloud.es.io")) {
				warnings.push("Detected Elastic Cloud URL - ensure API key authentication is used");
			}
		} catch (_e) {
			errors.push("ES_URL is not a valid URL format");
		}
	}

	// Check authentication configuration
	const hasApiKey = !!Bun.env.ES_API_KEY;
	const hasUsername = !!Bun.env.ES_USERNAME;
	const hasPassword = !!Bun.env.ES_PASSWORD;

	if (!hasApiKey && (!hasUsername || !hasPassword)) {
		warnings.push(
			"No authentication configured. This may be fine for local development but should be set for production.",
		);
	}

	if (hasUsername && !hasPassword) {
		errors.push("ES_USERNAME provided but ES_PASSWORD is missing");
	}

	if (hasPassword && !hasUsername) {
		errors.push("ES_PASSWORD provided but ES_USERNAME is missing");
	}

	// Check read-only configuration consistency
	const readOnlyMode = Bun.env.READ_ONLY_MODE?.toLowerCase() === "true";
	const readOnlyStrictMode = Bun.env.READ_ONLY_STRICT_MODE?.toLowerCase() === "true";

	if (!readOnlyMode && readOnlyStrictMode) {
		warnings.push("READ_ONLY_STRICT_MODE is enabled but READ_ONLY_MODE is disabled. STRICT_MODE will have no effect.");
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

interface LoadConfigResult {
	config: Config;
	warnings: string[];
}

export function loadConfig(): LoadConfigResult {
	// Validate environment first
	const envValidation = validateEnvironment();
	if (!envValidation.valid) {
		console.error(
			JSON.stringify({
				level: "ERROR",
				message: "Environment validation failed",
				errors: envValidation.errors,
			}),
		);
		process.exit(1);
	}

	const configWarnings = envValidation.warnings || [];

	// Merge default config with environment variables
	const envConfig = loadConfigFromEnv();
	const mergedConfig = {
		server: { ...defaultConfig.server, ...envConfig.server },
		elasticsearch: { ...defaultConfig.elasticsearch, ...envConfig.elasticsearch },
		logging: { ...defaultConfig.logging, ...envConfig.logging },
		security: { ...defaultConfig.security, ...envConfig.security },
		langsmith: { ...defaultConfig.langsmith, ...envConfig.langsmith },
		sessionTracking: { ...defaultConfig.sessionTracking, ...envConfig.sessionTracking },
	};

	// Validate merged configuration against schemas
	const config = ConfigSchema.parse(mergedConfig);

	return { config, warnings: configWarnings };
}
