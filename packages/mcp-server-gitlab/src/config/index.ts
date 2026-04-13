// src/config/index.ts

export { configDefaults } from "./defaults.js";
export type { EnvMappingEntry } from "./envMapping.js";
export { envMapping } from "./envMapping.js";
export { ConfigurationManager, configManager, getConfiguration, loadConfiguration } from "./loader.js";
export type { Config, TransportConfig } from "./schemas.js";
export { ConfigSchema } from "./schemas.js";
