// src/config/defaults.ts

/**
 * Default values used as fallbacks in loadFromEnvironment() when env vars are not set.
 * These align with the Zod schema .default() values but are the source of truth for
 * the environment-variable loading path.
 */
export const configDefaults = {
	application: {
		name: "kong-konnect-mcp",
		version: "2.0.0",
		environment: "development",
		logLevel: "info",
	},
	kong: {
		region: "us",
		timeout: "30000",
		retryAttempts: "3",
		retryDelay: "1000",
	},
	tracing: {
		enabled: "false",
		project: "konnect-mcp-server",
		endpoint: "https://api.smith.langchain.com",
		sessionName: "mcp-session",
		tags: ["mcp-server", "kong-konnect"],
		samplingRate: "1.0",
	},
	monitoring: {
		enabled: "true",
		healthCheckInterval: "30000",
		metricsCollection: "true",
		performanceThresholds: {
			responseTimeMs: "5000",
			errorRate: "5",
		},
	},
	runtime: {
		preferBunEnv: "true",
		envFileAutoLoad: "true",
		debugMode: "false",
	},
	transport: {
		mode: "stdio",
		port: "9083",
		host: "0.0.0.0",
		path: "/mcp",
		sessionMode: "stateless",
		idleTimeout: "255",
		apiKey: "",
		allowedOrigins: "",
	},
} as const;
