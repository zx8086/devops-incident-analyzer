// src/config/health.ts

import type { Config } from "./schemas.js";

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
		const trend = (scores[2] ?? 0) - (scores[0] ?? 0);
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
