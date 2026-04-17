// src/config/defaults.ts

export const configDefaults = {
	application: {
		name: "atlassian-mcp-server",
		version: "0.1.0",
		environment: "development",
		logLevel: "info",
	},
	atlassian: {
		baseUrl: "https://your-domain.atlassian.net",
		timeout: "30000",
		retryAttempts: "3",
		retryDelay: "1000",
	},
	tracing: {
		enabled: "false",
		project: "atlassian-mcp-server",
		endpoint: "https://api.smith.langchain.com",
		sessionName: "mcp-session",
		tags: ["mcp-server", "atlassian"],
		samplingRate: "1.0",
	},
	monitoring: {
		enabled: "true",
		healthCheckInterval: "30000",
		metricsCollection: "true",
	},
	transport: {
		mode: "stdio",
		port: "9085",
		host: "0.0.0.0",
		path: "/mcp",
		sessionMode: "stateless",
		idleTimeout: "255",
		apiKey: "",
		allowedOrigins: "",
	},
} as const;
