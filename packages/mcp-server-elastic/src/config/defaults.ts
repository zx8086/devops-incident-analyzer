// src/config/defaults.ts
import type { Config, ElasticCloudConfig } from "./schemas.js";

export const defaultConfig: Config = {
	server: {
		name: "elasticsearch-mcp-server",
		version: "0.1.1",
		readOnlyMode: false,
		readOnlyStrictMode: true,
		maxQueryTimeout: 30000,
		maxResultsPerQuery: 1000,
		transportMode: "stdio",
		port: 9080,
		host: "0.0.0.0",
		path: "/mcp",
		sessionMode: "stateless",
		idleTimeout: 255,
		maxResponseSizeBytes: 1000000,
		defaultPageSize: 20,
		maxPageSize: 100,
		enableResponseCompression: true,
		autoSummarizeLargeResponses: true,
		// Monitoring configuration
		monitoringPort: 9090,
	},
	elasticsearch: {
		url: "http://localhost:9200",
		maxRetries: 3,
		requestTimeout: 30000,
		compression: true,
		enableMetaHeader: true,
		disablePrototypePoisoningProtection: true,
	},
	logging: {
		level: "info",
		format: "json",
		includeMetadata: true,
	},
	security: {
		allowDestructiveOperations: false,
		allowSchemaModifications: false,
		allowIndexManagement: false,
		maxBulkOperations: 1000,
	},
	langsmith: {
		tracing: false,
		endpoint: "https://api.smith.langchain.com",
		project: "elasticsearch-mcp-server",
	},
	sessionTracking: {
		enabled: true,
		sessionTimeoutMinutes: 0.5, // 30 seconds for better conversation separation
		includeSessionInTraceName: false,
		maxConcurrentSessions: 100,
		conversationDetectionThresholdSeconds: 30, // Detect new conversation after 30s gap
	},
};

// SIO-674: Cloud defaults are kept separate from defaultConfig because config.cloud must
// remain undefined when EC_API_KEY is unset -- the loader merges these in only when the key
// is present so self-hosted ES users see no cloud surface.
export const cloudDefaults: Omit<ElasticCloudConfig, "apiKey" | "defaultOrgId"> = {
	endpoint: "https://api.elastic-cloud.com",
	requestTimeout: 30000,
	maxRetries: 3,
};
