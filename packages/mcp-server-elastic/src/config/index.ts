// src/config/index.ts
import { loadConfig } from "./loader.js";

export { defaultConfig } from "./defaults.js";
export { listDeploymentIds, loadDeploymentFromEnv } from "./deployments.js";
export { envVarMapping } from "./envMapping.js";
export { validateEnvironment } from "./loader.js";
export type { Config, DeploymentConfig, ElasticCloudConfig } from "./schemas.js";
export {
	ConfigSchema,
	DeploymentConfigSchema,
	ElasticCloudConfigSchema,
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
