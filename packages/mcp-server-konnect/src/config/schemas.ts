// src/config/schemas.ts

import { z } from "zod";

export const ConfigSchema = z.object({
	application: z
		.object({
			name: z.string().min(1).default("kong-konnect-mcp"),
			version: z
				.string()
				.regex(/^\d+\.\d+\.\d+$/, "Version must be semver format")
				.default("2.0.0"),
			environment: z.enum(["development", "staging", "production", "test"]).default("development"),
			logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
		})
		.describe("Core application settings"),

	kong: z
		.object({
			accessToken: z.string().min(1, "Kong Konnect access token is required").describe("Kong Konnect API access token"),
			region: z.enum(["us", "eu", "au", "me", "in"]).default("us").describe("Kong Konnect API region"),
			baseUrl: z
				.string()
				.url()
				.optional()
				.describe("Custom Kong API base URL (auto-generated from region if not provided)"),
			timeout: z.number().min(1000).max(60000).default(30000).describe("API request timeout in milliseconds"),
			retryAttempts: z.number().min(0).max(5).default(3).describe("Number of retry attempts for failed requests"),
			retryDelay: z.number().min(100).max(5000).default(1000).describe("Delay between retry attempts in milliseconds"),
		})
		.describe("Kong Konnect API configuration"),

	tracing: z
		.object({
			enabled: z.boolean().default(false).describe("Enable LangSmith tracing"),
			apiKey: z.string().optional().describe("LangSmith API key (required when tracing is enabled)"),
			project: z.string().default("konnect-mcp-server").describe("LangSmith project name"),
			endpoint: z.string().url().default("https://api.smith.langchain.com"),
			sessionName: z.string().default("mcp-session").describe("Session name for tracing"),
			tags: z.array(z.string()).default(["mcp-server", "kong-konnect"]).describe("Tags for tracing sessions"),
			samplingRate: z.number().min(0).max(1).default(1.0).describe("Sampling rate for traces (0.0 to 1.0)"),
		})
		.describe("LangSmith tracing and observability"),

	monitoring: z
		.object({
			enabled: z.boolean().default(true).describe("Enable performance monitoring"),
			healthCheckInterval: z
				.number()
				.min(5000)
				.max(300000)
				.default(30000)
				.describe("Health check interval in milliseconds"),
			metricsCollection: z.boolean().default(true).describe("Enable metrics collection"),
			performanceThresholds: z
				.object({
					responseTimeMs: z
						.number()
						.min(1)
						.max(10000)
						.default(5000)
						.describe("Response time threshold in milliseconds"),
					errorRate: z.number().min(0).max(100).default(5).describe("Error rate threshold as percentage"),
				})
				.describe("Performance monitoring thresholds"),
		})
		.describe("Monitoring and health check configuration"),

	runtime: z
		.object({
			preferBunEnv: z.boolean().default(true).describe("Prefer Bun.env over process.env when available"),
			envFileAutoLoad: z.boolean().default(true).describe("Auto-load .env files (Bun does this automatically)"),
			debugMode: z.boolean().default(false).describe("Enable debug mode for additional logging"),
		})
		.describe("Runtime-specific configuration"),

	transport: z
		.object({
			mode: z.enum(["stdio", "http", "both", "agentcore"]).describe("Transport mode"),
			port: z.number().int().min(1024).max(65535).describe("HTTP server port"),
			host: z.string().describe("HTTP server host"),
			path: z.string().startsWith("/").describe("MCP endpoint path"),
			sessionMode: z.enum(["stateless", "stateful"]).describe("HTTP session mode"),
			idleTimeout: z.number().int().min(10).max(255).describe("Idle timeout in seconds"),
			apiKey: z.string().describe("API key for authentication"),
			allowedOrigins: z.string().describe("Comma-separated allowed origins"),
		})
		.describe("Transport configuration for MCP server"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TransportConfig = Config["transport"];
