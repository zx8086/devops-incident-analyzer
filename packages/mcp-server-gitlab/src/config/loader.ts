// src/config/loader.ts

import { z } from "zod";
import { getEnvVar, getEnvVarWithDefault, initializeEnvironment } from "../utils/env.js";
import { createContextLogger } from "../utils/logger.js";
import { configDefaults } from "./defaults.js";
import type { Config } from "./schemas.js";
import { ConfigSchema } from "./schemas.js";

const log = createContextLogger("config");

export class ConfigurationManager {
	private config: Config | null = null;

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
			gitlab: {
				instanceUrl: getEnvVarWithDefault("GITLAB_INSTANCE_URL", configDefaults.gitlab.instanceUrl),
				personalAccessToken: getEnvVar("GITLAB_PERSONAL_ACCESS_TOKEN") || "",
				defaultProjectId: getEnvVar("GITLAB_DEFAULT_PROJECT_ID") || undefined,
				timeout: parseInt(getEnvVarWithDefault("GITLAB_TIMEOUT", configDefaults.gitlab.timeout), 10),
				retryAttempts: parseInt(getEnvVarWithDefault("GITLAB_RETRY_ATTEMPTS", configDefaults.gitlab.retryAttempts), 10),
				retryDelay: parseInt(getEnvVarWithDefault("GITLAB_RETRY_DELAY", configDefaults.gitlab.retryDelay), 10),
			},
			tracing: {
				enabled: getEnvVarWithDefault("LANGSMITH_TRACING", configDefaults.tracing.enabled) === "true",
				apiKey: getEnvVar("LANGSMITH_API_KEY"),
				project:
					getEnvVar("GITLAB_LANGSMITH_PROJECT") ||
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
			this.logConfiguration(this.config);
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

		for (const issue of error.issues) {
			const path = issue.path.join(".");
			if (path === "gitlab.personalAccessToken") {
				log.warn("TIP: Set GITLAB_PERSONAL_ACCESS_TOKEN environment variable with your GitLab PAT (api scope)");
			}
		}
	}

	private logConfiguration(config: Config): void {
		log.debug(
			{
				environment: config.application.environment,
				logLevel: config.application.logLevel,
				gitlabInstance: config.gitlab.instanceUrl,
				tracingEnabled: config.tracing.enabled,
			},
			"Configuration loaded successfully",
		);
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
}

export const configManager = new ConfigurationManager();

export async function loadConfiguration(): Promise<Config> {
	return configManager.load();
}

export function getConfiguration(): Config {
	return configManager.get();
}
