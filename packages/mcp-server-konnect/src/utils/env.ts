/**
 * Universal environment variable access utility for Bun + Node.js compatibility
 * Optimized for Bun runtime with Node.js fallback support
 */

import { createContextLogger } from "./mcp-logger.js";

const log = createContextLogger("config");

/**
 * Universal environment variable access with Bun optimization
 * Prefers Bun.env for performance but falls back to process.env
 */
export function getEnvVar(key: string): string | undefined {
	// Runtime detection - use Bun.env if available for better performance
	if (typeof Bun !== "undefined" && Bun.env) {
		return Bun.env[key];
	}

	// Fallback to standard process.env for Node.js compatibility
	return process.env[key];
}

/**
 * Get environment variable with default value
 */
export function getEnvVarWithDefault(key: string, defaultValue: string): string {
	return getEnvVar(key) ?? defaultValue;
}

/**
 * Check if running under Bun runtime
 */
export function isBunRuntime(): boolean {
	return typeof Bun !== "undefined";
}

/**
 * Get runtime information for debugging
 */
export function getRuntimeInfo(): {
	runtime: "bun" | "node" | "unknown";
	version: string;
	envSource: "Bun.env" | "process.env";
	autoEnvLoading: boolean;
} {
	if (typeof Bun !== "undefined") {
		return {
			runtime: "bun",
			version: Bun.version,
			envSource: "Bun.env",
			autoEnvLoading: true,
		};
	} else if (typeof process !== "undefined" && process.versions?.node) {
		return {
			runtime: "node",
			version: process.version,
			envSource: "process.env",
			autoEnvLoading: false,
		};
	} else {
		return {
			runtime: "unknown",
			version: "unknown",
			envSource: "process.env",
			autoEnvLoading: false,
		};
	}
}

/**
 * Load environment variables with proper error handling
 * Bun loads .env files automatically, Node.js needs manual loading
 */
export async function initializeEnvironment(): Promise<void> {
	// Skip initialization if running under Bun (auto-loads .env files)
	if (isBunRuntime()) {
		log.info("Running under Bun - .env auto-loading enabled");
		return;
	}

	// For Node.js environments, try to load .env files manually
	try {
		// @ts-expect-error dotenv is an optional dependency for Node.js environments
		const { config } = await import("dotenv");

		// Try loading .env from multiple locations
		const envPaths = [".env", "src/.env", "../.env"];

		let loaded = false;
		for (const path of envPaths) {
			const result = config({ path, override: false });
			if (!result.error) {
				log.info({ path }, "Loaded environment variables from file");
				loaded = true;
				break;
			}
		}

		if (!loaded) {
			log.debug("No .env file found - using system environment variables only");
		}
	} catch (_error) {
		log.warn("dotenv not available - install with: npm install dotenv");
		log.info("Using system environment variables only");
	}
}
