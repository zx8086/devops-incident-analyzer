// src/config/schemas.ts

import { z } from "zod";

export const ConfigSchema = z.object({
	application: z
		.object({
			name: z.string().min(1),
			version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be semver format"),
			environment: z.enum(["development", "staging", "production", "test"]),
			logLevel: z.enum(["debug", "info", "warn", "error"]),
		})
		.describe("Core application settings"),

	atlassian: z
		.object({
			cloudId: z.string().optional().describe("Atlassian Cloud ID"),
			email: z.string().optional().describe("Atlassian account email for basic auth"),
			apiToken: z.string().min(1, "Atlassian API token is required").describe("API token for authentication"),
			baseUrl: z.string().url().describe("Atlassian base URL (e.g. https://your-domain.atlassian.net)"),
			timeout: z.number().min(1000).max(60000).describe("API request timeout in milliseconds"),
			retryAttempts: z.number().min(0).max(5).describe("Number of retry attempts for failed requests"),
			retryDelay: z.number().min(100).max(5000).describe("Delay between retry attempts in milliseconds"),
		})
		.describe("Atlassian API configuration"),

	tracing: z
		.object({
			enabled: z.boolean().describe("Enable LangSmith tracing"),
			apiKey: z.string().optional().describe("LangSmith API key"),
			project: z.string().describe("LangSmith project name"),
			endpoint: z.string().url(),
			sessionName: z.string().describe("Session name for tracing"),
			tags: z.array(z.string()).describe("Tags for tracing sessions"),
			samplingRate: z.number().min(0).max(1).describe("Sampling rate for traces"),
		})
		.describe("LangSmith tracing and observability"),

	monitoring: z
		.object({
			enabled: z.boolean().describe("Enable performance monitoring"),
			healthCheckInterval: z.number().min(5000).max(300000).describe("Health check interval in milliseconds"),
			metricsCollection: z.boolean().describe("Enable metrics collection"),
		})
		.describe("Monitoring configuration"),

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
