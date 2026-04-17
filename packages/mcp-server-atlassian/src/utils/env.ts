// src/utils/env.ts

import { createContextLogger } from "./logger.js";

const log = createContextLogger("config");

export function getEnvVar(key: string): string | undefined {
	if (typeof Bun !== "undefined" && Bun.env) {
		return Bun.env[key];
	}
	return process.env[key];
}

export function getEnvVarWithDefault(key: string, defaultValue: string): string {
	return getEnvVar(key) ?? defaultValue;
}

export function isBunRuntime(): boolean {
	return typeof Bun !== "undefined";
}

export function getRuntimeInfo(): {
	runtime: "bun" | "node" | "unknown";
	version: string;
	envSource: "Bun.env" | "process.env";
} {
	if (typeof Bun !== "undefined") {
		return { runtime: "bun", version: Bun.version, envSource: "Bun.env" };
	}
	if (typeof process !== "undefined" && process.versions?.node) {
		return { runtime: "node", version: process.version, envSource: "process.env" };
	}
	return { runtime: "unknown", version: "unknown", envSource: "process.env" };
}

export async function initializeEnvironment(): Promise<void> {
	if (isBunRuntime()) {
		log.debug("Running under Bun - .env auto-loading enabled");
		return;
	}

	try {
		// @ts-expect-error dotenv is an optional dependency for Node.js environments
		const { config } = await import("dotenv");
		const envPaths = [".env", "src/.env", "../.env"];
		for (const path of envPaths) {
			const result = config({ path, override: false });
			if (!result.error) {
				log.info({ path }, "Loaded environment variables from file");
				return;
			}
		}
		log.debug("No .env file found - using system environment variables only");
	} catch (_error) {
		log.info("Using system environment variables only");
	}
}
