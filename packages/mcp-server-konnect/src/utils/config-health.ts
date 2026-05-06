#!/usr/bin/env bun

/**
 * Configuration Health Check and Validation Utility for Kong Konnect MCP Server
 * Run with: bun run src/utils/config-health.ts
 */

import { type Config, type ConfigurationHealth, configManager } from "../config/index.js";
import { getRuntimeInfo } from "./env.js";

interface HealthCheckResult {
	success: boolean;
	config?: Config;
	health?: ConfigurationHealth;
	error?: string;
}

async function runConfigurationHealthCheck(): Promise<HealthCheckResult> {
	try {
		console.error("INFO: Kong Konnect MCP Server Configuration Health Check");
		console.error("=".repeat(60));

		// Show runtime information
		const runtimeInfo = getRuntimeInfo();
		console.error(`\nINFO: Runtime Information:`);
		console.error(`   Runtime: ${runtimeInfo.runtime} ${runtimeInfo.version}`);
		console.error(`   Env Source: ${runtimeInfo.envSource}`);
		console.error(`   Auto .env Loading: ${runtimeInfo.autoEnvLoading ? "YES" : "NO"}`);

		// Load configuration
		console.error("\nINFO:  Loading Configuration...");
		const config = await configManager.load();
		console.error("SUCCESS: Configuration loaded successfully");

		// Run health assessment
		console.error("\nINFO: Running Health Assessment...");
		const health = await configManager.getHealth();

		// Display health summary
		console.error("\nINFO: Health Summary:");
		console.error(`   Status: ${getStatusEmoji(health.status)} ${health.status.toUpperCase()}`);
		console.error(`   Security Score: ${health.metrics.securityScore}%`);
		console.error(`   Environment Consistency: ${health.metrics.environmentConsistency}%`);
		console.error(`   Configuration Complexity: ${health.metrics.configurationComplexity}/100`);
		console.error(`   Validation Performance: ${health.metrics.validationPerformance}ms`);

		// Display issues
		if (health.issues.critical.length > 0) {
			console.error("\nCRITICAL: CRITICAL ISSUES:");
			health.issues.critical.forEach((issue, index) => {
				console.error(`   ${index + 1}. ${issue.path}: ${issue.message}`);
				console.error(`      TIP: ${issue.remediation}`);
			});
		}

		if (health.issues.warnings.length > 0) {
			console.error("\nWARNING:  WARNINGS:");
			health.issues.warnings.forEach((issue, index) => {
				console.error(`   ${index + 1}. ${issue.path}: ${issue.message}`);
			});
		}

		if (health.issues.info.length > 0) {
			console.error("\nINFO:  INFO:");
			health.issues.info.forEach((issue, index) => {
				console.error(`   ${index + 1}. ${issue.path}: ${issue.message}`);
			});
		}

		// Display recommendations
		if (health.recommendations.length > 0) {
			console.error("\nTIP: RECOMMENDATIONS:");
			health.recommendations.forEach((rec, index) => {
				console.error(`   ${index + 1}. ${rec}`);
			});
		}

		// Configuration summary
		console.error("\nINFO:  Configuration Summary:");
		console.error(`   Environment: ${config.application.environment}`);
		console.error(`   Log Level: ${config.application.logLevel}`);
		console.error(`   Kong Region: ${config.kong.region}`);
		console.error(`   Kong Token Set: ${config.kong.accessToken ? "YES" : "NO"}`);
		console.error(`   Tracing Enabled: ${config.tracing.enabled ? "YES" : "NO"}`);
		console.error(`   Monitoring Enabled: ${config.monitoring.enabled ? "YES" : "NO"}`);

		// Health trends if available
		const trends = configManager.getHealthTrends();
		if (trends.trend !== "stable") {
			console.error("\nINFO: Health Trends:");
			console.error(`   Trend: ${getTrendEmoji(trends.trend)} ${trends.trend.toUpperCase()}`);
			console.error(`   Analysis: ${trends.analysis}`);
		}

		// Final status
		console.error(`\n${"=".repeat(60)}`);
		if (health.status === "critical") {
			console.error("ERROR: CONFIGURATION HEALTH CHECK FAILED");
			console.error("   Fix critical issues before running the MCP server");
			return { success: false, config, health };
		} else if (health.status === "unhealthy") {
			console.error("WARNING:  CONFIGURATION HEALTH CHECK - ISSUES DETECTED");
			console.error("   Server can run but consider addressing warnings");
			return { success: true, config, health };
		} else {
			console.error("SUCCESS: CONFIGURATION HEALTH CHECK PASSED");
			console.error("   Server ready to start");
			return { success: true, config, health };
		}
	} catch (error: unknown) {
		console.error(`\n${"=".repeat(60)}`);
		console.error("ERROR: CONFIGURATION HEALTH CHECK FAILED");
		const errMessage = error instanceof Error ? error.message : String(error);
		console.error(`   Error: ${errMessage}`);

		// ZodError carries .name === "ZodError" and an .issues array.
		const zodError =
			error && typeof error === "object" && (error as { name?: unknown }).name === "ZodError"
				? (error as { issues?: Array<{ path: Array<string | number>; message: string }> })
				: null;
		if (zodError) {
			console.error("\nINFO: Validation Errors:");
			zodError.issues?.forEach((issue, index) => {
				console.error(`   ${index + 1}. ${issue.path.join(".")}: ${issue.message}`);
			});

			console.error("\nTIP: Common Solutions:");
			if (zodError.issues?.some((i) => i.path.includes("accessToken"))) {
				console.error("   - Set KONNECT_ACCESS_TOKEN in your .env file");
				console.error("   - Get your token from: https://cloud.konghq.com/");
			}
			if (zodError.issues?.some((i) => i.path.includes("apiKey"))) {
				console.error("   - Set LANGSMITH_API_KEY in your .env file");
				console.error("   - Or set LANGSMITH_TRACING=false to disable tracing");
			}
		}

		return { success: false, error: errMessage };
	}
}

function getStatusEmoji(status: string): string {
	switch (status) {
		case "healthy":
			return "HEALTHY";
		case "degraded":
			return "DEGRADED";
		case "unhealthy":
			return "UNHEALTHY";
		case "critical":
			return "CRITICAL";
		default:
			return "UNKNOWN";
	}
}

function getTrendEmoji(trend: string): string {
	switch (trend) {
		case "improving":
			return "IMPROVING";
		case "degrading":
			return "DEGRADING";
		case "stable":
			return "STABLE";
		default:
			return "UNKNOWN";
	}
}

// Production deployment safety check
async function runProductionSafetyCheck(): Promise<boolean> {
	console.error("\nINFO: Production Deployment Safety Check");
	console.error("-".repeat(40));

	try {
		const config = await configManager.load();

		if (config.application.environment !== "production") {
			console.error("INFO:  Not running in production mode - safety check skipped");
			return true;
		}

		const health = await configManager.getHealth();
		const safetyIssues: string[] = [];

		// Critical safety checks for production
		if (health.issues.critical.length > 0) {
			safetyIssues.push(`${health.issues.critical.length} critical configuration issues`);
		}

		if (health.metrics.securityScore < 70) {
			safetyIssues.push(`Security score too low: ${health.metrics.securityScore}%`);
		}

		if (
			config.kong.accessToken === "your-kong-konnect-access-token-here" ||
			config.kong.accessToken === "test" ||
			config.kong.accessToken.length < 10
		) {
			safetyIssues.push("Invalid or default Kong access token");
		}

		if (config.application.logLevel === "debug") {
			safetyIssues.push("Debug logging enabled in production");
		}

		if (config.runtime.debugMode) {
			safetyIssues.push("Debug mode enabled in production");
		}

		if (safetyIssues.length > 0) {
			console.error("CRITICAL: PRODUCTION DEPLOYMENT BLOCKED");
			console.error("   Safety Issues:");
			for (const issue of safetyIssues) {
				console.error(`   - ${issue}`);
			}
			console.error("\n   Fix these issues before deploying to production");
			return false;
		}

		console.error("SUCCESS: Production safety check passed");
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`ERROR: Production safety check failed: ${message}`);
		return false;
	}
}

// Export JSON Schema
async function exportConfigSchema(): Promise<void> {
	try {
		const _schema = configManager.exportJsonSchema("./config-schema.json");
		console.error("\nINFO: JSON Schema exported to: ./config-schema.json");

		// Also log a simplified version
		console.error("\nINFO: Configuration Schema Summary:");
		console.error("   - application: Core app settings (name, version, environment, logLevel)");
		console.error("   - kong: Kong Konnect API configuration (token, region, timeouts)");
		console.error("   - tracing: LangSmith tracing settings (enabled, apiKey, project)");
		console.error("   - monitoring: Performance monitoring configuration");
		console.error("   - runtime: Bun/Node.js runtime settings");
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`ERROR: Failed to export schema: ${message}`);
	}
}

// Main execution
async function main() {
	const args = process.argv.slice(2);

	if (args.includes("--production-check")) {
		const safe = await runProductionSafetyCheck();
		process.exit(safe ? 0 : 1);
	}

	if (args.includes("--export-schema")) {
		await exportConfigSchema();
		return;
	}

	const result = await runConfigurationHealthCheck();

	if (args.includes("--export-schema")) {
		await exportConfigSchema();
	}

	// Exit with appropriate code
	process.exit(result.success ? 0 : 1);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error("Health check failed:", error);
		process.exit(1);
	});
}
