// observability/src/logger.ts
import { buildEcsOptions, createFormattedDestination } from "@devops-agent/shared";
import pino from "pino";

function getEnv(key: string): string | undefined {
	// Support both Bun and Node.js environments (Vite SSR runs under Node)
	if (typeof globalThis.Bun !== "undefined") {
		return globalThis.Bun.env[key];
	}
	return process.env[key];
}

function isProdOrStaging(): boolean {
	const env = getEnv("NODE_ENV");
	return env === "production" || env === "staging";
}

function createBaseLogger(): pino.Logger {
	const level = getEnv("LOG_LEVEL") ?? "info";
	const ecsOpts = buildEcsOptions({ serviceName: "devops-agent" });

	if (!isProdOrStaging()) {
		// Dev: colorized human-readable output to stdout
		return pino({ level, ...ecsOpts }, createFormattedDestination(1));
	}

	// Prod/staging: raw ECS NDJSON to stdout
	return pino({ level, ...ecsOpts });
}

const baseLogger = createBaseLogger();

export function getLogger(service: string): pino.Logger {
	return baseLogger.child({ service });
}

export function getChildLogger(parent: pino.Logger, component: string): pino.Logger {
	return parent.child({ component });
}
