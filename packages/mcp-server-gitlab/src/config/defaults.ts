// src/config/defaults.ts

export const configDefaults = {
	application: {
		name: "gitlab-mcp-server",
		version: "0.1.0",
		environment: "development",
		logLevel: "info",
	},
	gitlab: {
		instanceUrl: "https://gitlab.com",
		timeout: "30000",
		retryAttempts: "3",
		retryDelay: "1000",
	},
	tracing: {
		enabled: "false",
		project: "gitlab-mcp-server",
		endpoint: "https://api.smith.langchain.com",
		sessionName: "mcp-session",
		tags: ["mcp-server", "gitlab"],
		samplingRate: "1.0",
	},
	monitoring: {
		enabled: "true",
		healthCheckInterval: "30000",
		metricsCollection: "true",
	},
	transport: {
		mode: "stdio",
		port: "9084",
		host: "0.0.0.0",
		path: "/mcp",
		sessionMode: "stateless",
		idleTimeout: "255",
		apiKey: "",
		allowedOrigins: "",
	},
} as const;
