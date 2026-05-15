// src/config/index.ts
import { type Config, ConfigSchema } from "./schemas.ts";

let cached: Config | undefined;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const parsed = ConfigSchema.parse(env);
	cached = parsed;
	return parsed;
}

export function getConfig(): Config {
	if (!cached) {
		cached = ConfigSchema.parse(process.env);
	}
	return cached;
}

// Test-only: reset the singleton.
export function _resetConfigCacheForTests(): void {
	cached = undefined;
}

export type { AwsConfig, Config, TransportConfig } from "./schemas.ts";
export { ConfigSchema };
