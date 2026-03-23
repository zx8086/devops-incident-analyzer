/* src/config/index.ts */

import { z } from "zod";
import { getEnvVar, getEnvVarWithDefault, getRuntimeInfo, initializeEnvironment } from "../utils/env.js";
import { mcpLogger } from "../utils/mcp-logger.js";
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
			mode: z.enum(["stdio", "http", "both"]).describe("Transport mode"),
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
export interface ConfigurationHealth {
	status: "healthy" | "degraded" | "unhealthy" | "critical";
	timestamp: number;
	environment: string;
	issues: {
		critical: ConfigurationIssue[];
		warnings: ConfigurationIssue[];
		info: ConfigurationIssue[];
	};
	metrics: {
		configurationComplexity: number;
		validationPerformance: number;
		securityScore: number;
		environmentConsistency: number;
	};
	recommendations: string[];
}
export interface ConfigurationIssue {
	path: string;
	message: string;
	severity: "critical" | "warning" | "info";
	remediation: string;
}
export class ConfigurationHealthMonitor {
	private healthHistory: ConfigurationHealth[] = [];
	async assessConfigurationHealth(config: Config): Promise<ConfigurationHealth> {
		const startTime = Date.now();
		const health: ConfigurationHealth = {
			status: "healthy",
			timestamp: startTime,
			environment: config.application.environment,
			issues: {
				critical: [],
				warnings: [],
				info: [],
			},
			metrics: {
				configurationComplexity: 0,
				validationPerformance: 0,
				securityScore: 0,
				environmentConsistency: 0,
			},
			recommendations: [],
		};
		try {
			health.metrics.configurationComplexity = this.calculateComplexity(config);
			health.metrics.securityScore = this.calculateSecurityScore(config);
			health.metrics.environmentConsistency = this.assessEnvironmentConsistency(config);

			this.analyzeConfigurationIssues(config, health);

			this.generateRecommendations(config, health);

			health.status = this.determineHealthStatus(health);

			health.metrics.validationPerformance = Math.max(Date.now() - startTime, 1);

			this.updateHealthHistory(health);
			return health;
		} catch (error) {
			health.status = "critical";
			health.issues.critical.push({
				path: "system",
				message: `Configuration health assessment failed: ${error instanceof Error ? error.message : String(error)}`,
				severity: "critical",
				remediation: "Check configuration system integrity",
			});
			return health;
		}
	}
	private calculateComplexity(config: Config): number {
		let complexity = 0;

		complexity += Object.keys(config).length * 5;
		complexity += Object.keys(config.kong).length * 3;
		complexity += Object.keys(config.tracing).length * 2;
		complexity += Object.keys(config.monitoring).length * 2;
		complexity += Object.keys(config.runtime).length * 1;
		return Math.min(complexity, 100);
	}
	private calculateSecurityScore(config: Config): number {
		let securityScore = 100;

		if (config.kong.accessToken.length < 20) securityScore -= 20;
		if (config.kong.accessToken === "your-token-here" || config.kong.accessToken === "test") securityScore -= 40;

		if (config.tracing.enabled) {
			if (!config.tracing.apiKey) securityScore -= 30;
			else if (config.tracing.apiKey.length < 20) securityScore -= 10;
			else if (!config.tracing.apiKey.startsWith("lsv2_")) securityScore -= 5;
		}

		if (config.application.environment === "production") {
			if (config.application.logLevel === "debug") securityScore -= 10;
			if (config.runtime.debugMode) securityScore -= 15;
		}
		return Math.max(securityScore, 0);
	}
	private assessEnvironmentConsistency(config: Config): number {
		let consistencyScore = 100;

		if (config.application.environment === "production") {
			if (config.application.logLevel === "debug") consistencyScore -= 10;
			if (config.runtime.debugMode) consistencyScore -= 15;
			if (config.tracing.samplingRate > 0.5) consistencyScore -= 5;
		}
		if (config.application.environment === "development") {
			if (config.application.logLevel === "error") consistencyScore -= 5;
			if (!config.runtime.debugMode) consistencyScore -= 5;
		}

		if (config.kong.timeout < 5000 && config.application.environment === "production") {
			consistencyScore -= 10;
		}
		return Math.max(consistencyScore, 0);
	}
	private analyzeConfigurationIssues(config: Config, health: ConfigurationHealth): void {
		const env = config.application.environment;

		if (!config.kong.accessToken || config.kong.accessToken.trim() === "") {
			health.issues.critical.push({
				path: "kong.accessToken",
				message: "Kong Konnect access token is required",
				severity: "critical",
				remediation: "Set KONNECT_ACCESS_TOKEN environment variable",
			});
		}
		if (config.tracing.enabled && !config.tracing.apiKey) {
			health.issues.critical.push({
				path: "tracing.apiKey",
				message: "LangSmith API key required when tracing is enabled",
				severity: "critical",
				remediation: "Set LANGSMITH_API_KEY environment variable or disable tracing",
			});
		}

		if (env === "production") {
			if (config.kong.accessToken === "test" || config.kong.accessToken === "your-token-here") {
				health.issues.critical.push({
					path: "kong.accessToken",
					message: "Default/test access token not allowed in production",
					severity: "critical",
					remediation: "Set a valid production Kong Konnect access token",
				});
			}
		}

		if (config.kong.timeout > 45000) {
			health.issues.warnings.push({
				path: "kong.timeout",
				message: `Kong API timeout very high: ${config.kong.timeout}ms`,
				severity: "warning",
				remediation: "Consider reducing timeout for faster failure detection",
			});
		}
		if (config.application.logLevel === "debug" && env === "production") {
			health.issues.warnings.push({
				path: "application.logLevel",
				message: "Debug logging enabled in production",
				severity: "warning",
				remediation: 'Use "info" or "warn" log level in production',
			});
		}
		if (config.tracing.enabled && config.tracing.apiKey && !config.tracing.apiKey.startsWith("lsv2_")) {
			health.issues.warnings.push({
				path: "tracing.apiKey",
				message: "LangSmith API key may not be in correct format",
				severity: "warning",
				remediation: 'LangSmith API keys typically start with "lsv2_"',
			});
		}

		if (!config.monitoring.enabled) {
			health.issues.info.push({
				path: "monitoring.enabled",
				message: "Performance monitoring disabled",
				severity: "info",
				remediation: "Enable monitoring for better observability",
			});
		}
		if (config.monitoring.healthCheckInterval < 10000) {
			health.issues.info.push({
				path: "monitoring.healthCheckInterval",
				message: "Very frequent health checks - may impact performance",
				severity: "info",
				remediation: "Consider if such frequent health checks are necessary",
			});
		}
	}
	private generateRecommendations(config: Config, health: ConfigurationHealth): void {
		if (health.metrics.securityScore < 80) {
			health.recommendations.push("Review security configuration - score below 80%");
		}

		if (config.kong.timeout > 30000) {
			health.recommendations.push("Consider reducing Kong API timeout for better responsiveness");
		}

		if (config.application.environment === "production") {
			if (health.metrics.environmentConsistency < 90) {
				health.recommendations.push("Configuration not optimized for production environment");
			}
			if (!config.monitoring.enabled) {
				health.recommendations.push("Enable monitoring in production for better observability");
			}
		}
		if (config.application.environment === "development") {
			if (config.application.logLevel !== "debug") {
				health.recommendations.push("Consider debug logging in development for better troubleshooting");
			}
		}

		if (
			config.tracing.enabled &&
			config.tracing.samplingRate === 1.0 &&
			config.application.environment === "production"
		) {
			health.recommendations.push("Consider reducing sampling rate in production to improve performance");
		}
		if (!config.tracing.enabled && config.application.environment !== "production") {
			health.recommendations.push("Consider enabling tracing in non-production environments for debugging");
		}

		if (config.kong.retryAttempts === 0) {
			health.recommendations.push("Consider enabling retry attempts for improved resilience");
		}
		if (config.kong.retryDelay < 500) {
			health.recommendations.push("Consider increasing retry delay to avoid overwhelming the API");
		}
	}
	private determineHealthStatus(health: ConfigurationHealth): "healthy" | "degraded" | "unhealthy" | "critical" {
		if (health.issues.critical.length > 0) {
			return "critical";
		}
		if (health.issues.warnings.length > 5) {
			return "unhealthy";
		}
		if (health.issues.warnings.length > 0 || health.metrics.securityScore < 80) {
			return "degraded";
		}
		return "healthy";
	}
	private updateHealthHistory(health: ConfigurationHealth): void {
		this.healthHistory.push(health);

		if (this.healthHistory.length > 50) {
			this.healthHistory.shift();
		}
	}
	getHealthTrends(): {
		trend: "improving" | "stable" | "degrading";
		analysis: string;
	} {
		if (this.healthHistory.length < 3) {
			return {
				trend: "stable",
				analysis: "Insufficient data for trend analysis",
			};
		}
		const recent = this.healthHistory.slice(-3);
		const scores = recent.map((h) => this.getHealthScore(h.status));
		const trend = scores[2] - scores[0];
		if (trend > 0) {
			return {
				trend: "improving",
				analysis: `Configuration health improving (${scores[0]} → ${scores[2]})`,
			};
		} else if (trend < 0) {
			return {
				trend: "degrading",
				analysis: `Configuration health degrading (${scores[0]} → ${scores[2]})`,
			};
		} else {
			return {
				trend: "stable",
				analysis: "Configuration health stable",
			};
		}
	}
	private getHealthScore(status: string): number {
		switch (status) {
			case "healthy":
				return 4;
			case "degraded":
				return 3;
			case "unhealthy":
				return 2;
			case "critical":
				return 1;
			default:
				return 0;
		}
	}
}
export class ConfigurationManager {
	private config: Config | null = null;
	private healthMonitor = new ConfigurationHealthMonitor();
	private loadFromEnvironment(): Partial<Config> {
		return {
			application: {
				name: getEnvVarWithDefault("APPLICATION_NAME", "kong-konnect-mcp"),
				version: getEnvVarWithDefault("APPLICATION_VERSION", "2.0.0"),
				environment: getEnvVarWithDefault("NODE_ENV", "development") as any,
				logLevel: getEnvVarWithDefault("LOG_LEVEL", "info") as any,
			},
			kong: {
				accessToken: getEnvVar("KONNECT_ACCESS_TOKEN") || "",
				region: getEnvVarWithDefault("KONNECT_REGION", "us") as any,
				baseUrl: getEnvVar("KONNECT_BASE_URL"),
				timeout: parseInt(getEnvVarWithDefault("KONNECT_TIMEOUT", "30000")),
				retryAttempts: parseInt(getEnvVarWithDefault("KONNECT_RETRY_ATTEMPTS", "3")),
				retryDelay: parseInt(getEnvVarWithDefault("KONNECT_RETRY_DELAY", "1000")),
			},
			tracing: {
				enabled: getEnvVarWithDefault("LANGSMITH_TRACING", "false") === "true",
				apiKey: getEnvVar("LANGSMITH_API_KEY"),
				project:
					getEnvVar("KONNECT_LANGSMITH_PROJECT") || getEnvVarWithDefault("LANGSMITH_PROJECT", "konnect-mcp-server"),
				endpoint: getEnvVarWithDefault("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com"),
				sessionName: getEnvVarWithDefault("LANGSMITH_SESSION", "mcp-session"),
				tags: getEnvVar("LANGSMITH_TAGS")?.split(",") || ["mcp-server", "kong-konnect"],
				samplingRate: parseFloat(getEnvVarWithDefault("LANGSMITH_SAMPLING_RATE", "1.0")),
			},
			monitoring: {
				enabled: getEnvVarWithDefault("MONITORING_ENABLED", "true") === "true",
				healthCheckInterval: parseInt(getEnvVarWithDefault("HEALTH_CHECK_INTERVAL", "30000")),
				metricsCollection: getEnvVarWithDefault("METRICS_COLLECTION", "true") === "true",
				performanceThresholds: {
					responseTimeMs: parseInt(getEnvVarWithDefault("PERFORMANCE_RESPONSE_TIME_MS", "5000")),
					errorRate: parseFloat(getEnvVarWithDefault("PERFORMANCE_ERROR_RATE", "5")),
				},
			},
			runtime: {
				preferBunEnv: getEnvVarWithDefault("PREFER_BUN_ENV", "true") === "true",
				envFileAutoLoad: getEnvVarWithDefault("ENV_FILE_AUTO_LOAD", "true") === "true",
				debugMode: getEnvVarWithDefault("DEBUG_MODE", "false") === "true",
			},
			transport: {
				mode: getEnvVarWithDefault("MCP_TRANSPORT", "stdio") as "stdio" | "http" | "both",
				port: parseInt(getEnvVarWithDefault("MCP_PORT", "9083")),
				host: getEnvVarWithDefault("MCP_HOST", "0.0.0.0"),
				path: getEnvVarWithDefault("MCP_PATH", "/mcp"),
				sessionMode: getEnvVarWithDefault("MCP_SESSION_MODE", "stateless") as "stateless" | "stateful",
				idleTimeout: parseInt(getEnvVarWithDefault("MCP_IDLE_TIMEOUT", "255")),
				apiKey: getEnvVarWithDefault("MCP_API_KEY", ""),
				allowedOrigins: getEnvVarWithDefault("MCP_ALLOWED_ORIGINS", ""),
			},
		};
	}
	public async load(): Promise<Config> {
		try {
			await initializeEnvironment();

			const envConfig = this.loadFromEnvironment();

			this.config = ConfigSchema.parse(envConfig);

			const health = await this.healthMonitor.assessConfigurationHealth(this.config);

			this.logConfiguration(this.config, health);
			return this.config;
		} catch (error) {
			if (error instanceof z.ZodError) {
				this.handleValidationError(error);
			}
			throw error;
		}
	}
	private handleValidationError(error: z.ZodError): void {
		const issues = error.issues
			.map((issue) => {
				const path = issue.path.join(".");
				return `  - ${path}: ${issue.message}`;
			})
			.join("\n");
		mcpLogger.error("config", "Configuration validation failed", { issues });

		error.issues.forEach((issue) => {
			const path = issue.path.join(".");
			if (path === "kong.accessToken") {
				mcpLogger.warning(
					"config",
					"TIP: Set KONNECT_ACCESS_TOKEN environment variable with your Kong Konnect API token",
				);
			}
			if (path === "tracing.apiKey" && getEnvVar("LANGSMITH_TRACING") === "true") {
				mcpLogger.warning("config", "TIP: Set LANGSMITH_API_KEY environment variable or set LANGSMITH_TRACING=false");
			}
		});
	}
	private logConfiguration(config: Config, health: ConfigurationHealth): void {
		const sanitized = JSON.parse(
			JSON.stringify(config, (key, value) => {
				const sensitiveKeys = ["accessToken", "apiKey", "token", "key"];
				if (sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
					return value ? "***REDACTED***" : undefined;
				}
				return value;
			}),
		);
		mcpLogger.info("config", "Configuration loaded successfully", {
			environment: config.application.environment,
			logLevel: config.application.logLevel,
			kongRegion: config.kong.region,
			tracingEnabled: config.tracing.enabled,
			healthStatus: health.status,
			securityScore: `${health.metrics.securityScore}%`,
			consistencyScore: `${health.metrics.environmentConsistency}%`,
		});
		if (health.recommendations.length > 0) {
			mcpLogger.info("config", "Configuration recommendations", {
				recommendations: health.recommendations,
			});
		}
		if (health.issues.critical.length > 0) {
			mcpLogger.error("config", "Configuration critical issues detected", {
				criticalIssues: health.issues.critical.map((issue) => ({
					path: issue.path,
					message: issue.message,
					remediation: issue.remediation,
				})),
			});
		}
		if (health.issues.warnings.length > 0) {
			mcpLogger.warning("config", "Configuration warnings detected", {
				warnings: health.issues.warnings.map((issue) => ({
					path: issue.path,
					message: issue.message,
				})),
			});
		}
	}

	public async exportJsonSchema(outputPath?: string): Promise<any> {
		const jsonSchema = {
			$schema: "http://json-schema.org/draft-07/schema#",
			$id: "https://docs.konghq.com/konnect/api/",
			title: "Kong Konnect MCP Configuration",
			type: "object",
			properties: {
				application: {
					type: "object",
					description: "Core application settings",
					properties: {
						name: { type: "string", minLength: 1 },
						version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
						environment: {
							type: "string",
							enum: ["development", "staging", "production", "test"],
						},
						logLevel: {
							type: "string",
							enum: ["debug", "info", "warn", "error"],
						},
					},
					required: ["name", "version", "environment", "logLevel"],
				},
				kong: {
					type: "object",
					description: "Kong Konnect API configuration",
					properties: {
						accessToken: { type: "string", minLength: 1 },
						region: { type: "string", enum: ["us", "eu", "au", "me", "in"] },
						baseUrl: { type: "string", format: "uri" },
						timeout: { type: "number", minimum: 1000, maximum: 60000 },
						retryAttempts: { type: "number", minimum: 0, maximum: 5 },
						retryDelay: { type: "number", minimum: 100, maximum: 5000 },
					},
					required: ["accessToken", "region", "timeout", "retryAttempts", "retryDelay"],
				},
				tracing: {
					type: "object",
					description: "LangSmith tracing and observability",
					properties: {
						enabled: { type: "boolean" },
						apiKey: { type: "string" },
						project: { type: "string" },
						endpoint: { type: "string", format: "uri" },
						sessionName: { type: "string" },
						tags: { type: "array", items: { type: "string" } },
						samplingRate: { type: "number", minimum: 0, maximum: 1 },
					},
					required: ["enabled", "project", "endpoint", "sessionName", "tags", "samplingRate"],
				},
				monitoring: {
					type: "object",
					description: "Monitoring and health check configuration",
					properties: {
						enabled: { type: "boolean" },
						healthCheckInterval: {
							type: "number",
							minimum: 5000,
							maximum: 300000,
						},
						metricsCollection: { type: "boolean" },
						performanceThresholds: {
							type: "object",
							properties: {
								responseTimeMs: { type: "number", minimum: 1, maximum: 10000 },
								errorRate: { type: "number", minimum: 0, maximum: 100 },
							},
							required: ["responseTimeMs", "errorRate"],
						},
					},
					required: ["enabled", "healthCheckInterval", "metricsCollection", "performanceThresholds"],
				},
				runtime: {
					type: "object",
					description: "Runtime-specific configuration",
					properties: {
						preferBunEnv: { type: "boolean" },
						envFileAutoLoad: { type: "boolean" },
						debugMode: { type: "boolean" },
					},
					required: ["preferBunEnv", "envFileAutoLoad", "debugMode"],
				},
			},
			required: ["application", "kong", "tracing", "monitoring", "runtime"],
		};
		if (outputPath) {
			const fs = await import("fs");
			fs.writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2));
			console.error(`JSON Schema exported to ${outputPath}`);
		}
		return jsonSchema;
	}

	public get(): Config {
		if (!this.config) {
			throw new Error("Configuration not loaded. Call load() first.");
		}
		return this.config;
	}

	public async reload(): Promise<Config> {
		return this.load();
	}

	public async getHealth(): Promise<ConfigurationHealth> {
		if (!this.config) {
			throw new Error("Configuration not loaded. Call load() first.");
		}
		return this.healthMonitor.assessConfigurationHealth(this.config);
	}

	public getHealthTrends() {
		return this.healthMonitor.getHealthTrends();
	}
}
export const configManager = new ConfigurationManager();
export async function loadConfiguration(): Promise<Config> {
	return configManager.load();
}
export function getConfiguration(): Config {
	return configManager.get();
}
