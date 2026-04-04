// src/config/loader.ts

import { z } from "zod";
import { getEnvVar, getEnvVarWithDefault, initializeEnvironment } from "../utils/env.js";
import { createContextLogger } from "../utils/logger.js";
import { configDefaults } from "./defaults.js";
import type { ConfigurationHealth } from "./health.js";
import { ConfigurationHealthMonitor } from "./health.js";
import type { Config } from "./schemas.js";
import { ConfigSchema } from "./schemas.js";

const log = createContextLogger("config");

export class ConfigurationManager {
	private config: Config | null = null;
	private healthMonitor = new ConfigurationHealthMonitor();

	private loadFromEnvironment(): Partial<Config> {
		return {
			application: {
				name: getEnvVarWithDefault("APPLICATION_NAME", configDefaults.application.name),
				version: getEnvVarWithDefault("APPLICATION_VERSION", configDefaults.application.version),
				environment: getEnvVarWithDefault(
					"NODE_ENV",
					configDefaults.application.environment,
				) as Config["application"]["environment"],
				logLevel: getEnvVarWithDefault(
					"LOG_LEVEL",
					configDefaults.application.logLevel,
				) as Config["application"]["logLevel"],
			},
			kong: {
				accessToken: getEnvVar("KONNECT_ACCESS_TOKEN") || "",
				region: getEnvVarWithDefault("KONNECT_REGION", configDefaults.kong.region) as Config["kong"]["region"],
				baseUrl: getEnvVar("KONNECT_BASE_URL"),
				timeout: parseInt(getEnvVarWithDefault("KONNECT_TIMEOUT", configDefaults.kong.timeout), 10),
				retryAttempts: parseInt(getEnvVarWithDefault("KONNECT_RETRY_ATTEMPTS", configDefaults.kong.retryAttempts), 10),
				retryDelay: parseInt(getEnvVarWithDefault("KONNECT_RETRY_DELAY", configDefaults.kong.retryDelay), 10),
			},
			tracing: {
				enabled: getEnvVarWithDefault("LANGSMITH_TRACING", configDefaults.tracing.enabled) === "true",
				apiKey: getEnvVar("LANGSMITH_API_KEY"),
				project:
					getEnvVar("KONNECT_LANGSMITH_PROJECT") ||
					getEnvVarWithDefault("LANGSMITH_PROJECT", configDefaults.tracing.project),
				endpoint: getEnvVarWithDefault("LANGSMITH_ENDPOINT", configDefaults.tracing.endpoint),
				sessionName: getEnvVarWithDefault("LANGSMITH_SESSION", configDefaults.tracing.sessionName),
				tags: getEnvVar("LANGSMITH_TAGS")?.split(",") || [...configDefaults.tracing.tags],
				samplingRate: parseFloat(getEnvVarWithDefault("LANGSMITH_SAMPLING_RATE", configDefaults.tracing.samplingRate)),
			},
			monitoring: {
				enabled: getEnvVarWithDefault("MONITORING_ENABLED", configDefaults.monitoring.enabled) === "true",
				healthCheckInterval: parseInt(
					getEnvVarWithDefault("HEALTH_CHECK_INTERVAL", configDefaults.monitoring.healthCheckInterval),
					10,
				),
				metricsCollection:
					getEnvVarWithDefault("METRICS_COLLECTION", configDefaults.monitoring.metricsCollection) === "true",
				performanceThresholds: {
					responseTimeMs: parseInt(
						getEnvVarWithDefault(
							"PERFORMANCE_RESPONSE_TIME_MS",
							configDefaults.monitoring.performanceThresholds.responseTimeMs,
						),
						10,
					),
					errorRate: parseFloat(
						getEnvVarWithDefault("PERFORMANCE_ERROR_RATE", configDefaults.monitoring.performanceThresholds.errorRate),
					),
				},
			},
			runtime: {
				preferBunEnv: getEnvVarWithDefault("PREFER_BUN_ENV", configDefaults.runtime.preferBunEnv) === "true",
				envFileAutoLoad: getEnvVarWithDefault("ENV_FILE_AUTO_LOAD", configDefaults.runtime.envFileAutoLoad) === "true",
				debugMode: getEnvVarWithDefault("DEBUG_MODE", configDefaults.runtime.debugMode) === "true",
			},
			transport: {
				mode: getEnvVarWithDefault("MCP_TRANSPORT", configDefaults.transport.mode) as Config["transport"]["mode"],
				port: parseInt(getEnvVarWithDefault("MCP_PORT", configDefaults.transport.port), 10),
				host: getEnvVarWithDefault("MCP_HOST", configDefaults.transport.host),
				path: getEnvVarWithDefault("MCP_PATH", configDefaults.transport.path),
				sessionMode: getEnvVarWithDefault(
					"MCP_SESSION_MODE",
					configDefaults.transport.sessionMode,
				) as Config["transport"]["sessionMode"],
				idleTimeout: parseInt(getEnvVarWithDefault("MCP_IDLE_TIMEOUT", configDefaults.transport.idleTimeout), 10),
				apiKey: getEnvVarWithDefault("MCP_API_KEY", configDefaults.transport.apiKey),
				allowedOrigins: getEnvVarWithDefault("MCP_ALLOWED_ORIGINS", configDefaults.transport.allowedOrigins),
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
		log.error({ issues }, "Configuration validation failed");

		error.issues.forEach((issue) => {
			const path = issue.path.join(".");
			if (path === "kong.accessToken") {
				log.warn("TIP: Set KONNECT_ACCESS_TOKEN environment variable with your Kong Konnect API token");
			}
			if (path === "tracing.apiKey" && getEnvVar("LANGSMITH_TRACING") === "true") {
				log.warn("TIP: Set LANGSMITH_API_KEY environment variable or set LANGSMITH_TRACING=false");
			}
		});
	}

	private logConfiguration(config: Config, health: ConfigurationHealth): void {
		const _sanitized = JSON.parse(
			JSON.stringify(config, (key, value) => {
				const sensitiveKeys = ["accessToken", "apiKey", "token", "key"];
				if (sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
					return value ? "***REDACTED***" : undefined;
				}
				return value;
			}),
		);
		log.info(
			{
				environment: config.application.environment,
				logLevel: config.application.logLevel,
				kongRegion: config.kong.region,
				tracingEnabled: config.tracing.enabled,
				healthStatus: health.status,
				securityScore: `${health.metrics.securityScore}%`,
				consistencyScore: `${health.metrics.environmentConsistency}%`,
			},
			"Configuration loaded successfully",
		);
		if (health.recommendations.length > 0) {
			log.info({ recommendations: health.recommendations }, "Configuration recommendations");
		}
		if (health.issues.critical.length > 0) {
			log.error(
				{
					criticalIssues: health.issues.critical.map((issue) => ({
						path: issue.path,
						message: issue.message,
						remediation: issue.remediation,
					})),
				},
				"Configuration critical issues detected",
			);
		}
		if (health.issues.warnings.length > 0) {
			log.warn(
				{ warnings: health.issues.warnings.map((issue) => ({ path: issue.path, message: issue.message })) },
				"Configuration warnings detected",
			);
		}
	}

	public async exportJsonSchema(outputPath?: string): Promise<Record<string, unknown>> {
		const jsonSchema: Record<string, unknown> = {
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
			const fs = await import("node:fs");
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
