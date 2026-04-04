// src/config/index.ts
import { defaultConfig } from "./defaults.js";
import { envVarMapping } from "./envMapping.js";
import { loadConfig } from "./loader.js";
import {
	ElasticsearchConfigSchema,
	LangSmithConfigSchema,
	LoggingConfigSchema,
	SecurityConfigSchema,
	ServerConfigSchema,
} from "./schemas.js";

export { defaultConfig } from "./defaults.js";
export { envVarMapping } from "./envMapping.js";
export { validateEnvironment } from "./loader.js";
export type { Config } from "./schemas.js";
export {
	ConfigSchema,
	ElasticsearchConfigSchema,
	LangSmithConfigSchema,
	LoggingConfigSchema,
	SecurityConfigSchema,
	ServerConfigSchema,
	SessionTrackingConfigSchema,
} from "./schemas.js";

let config: import("./schemas.js").Config;
let _configWarnings: string[] = [];

try {
	const result = loadConfig();
	config = result.config;
	_configWarnings = result.warnings;
} catch (error) {
	console.error(
		JSON.stringify({
			level: "ERROR",
			message: "Configuration validation failed",
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	throw new Error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
}

export { config };

export function getConfig(): import("./schemas.js").Config {
	return config;
}

export function getConfigWarnings(): string[] {
	return _configWarnings;
}

export function clearConfigWarnings(): void {
	_configWarnings = [];
}

export function getConfigDocumentation(): Record<string, unknown> {
	return {
		environmentVariables: envVarMapping,
		defaults: defaultConfig,
		schemas: {
			server: ServerConfigSchema.describe("Server configuration options"),
			elasticsearch: ElasticsearchConfigSchema.describe("Elasticsearch connection configuration"),
			logging: LoggingConfigSchema.describe("Logging configuration"),
			security: SecurityConfigSchema.describe("Security and permission configuration"),
			langsmith: LangSmithConfigSchema.describe("LangSmith tracing configuration"),
		},
	};
}
