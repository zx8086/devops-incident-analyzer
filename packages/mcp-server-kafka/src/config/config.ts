// src/config/config.ts

import { loadConfig } from "./loader.ts";
import type { AppConfig } from "./schemas.ts";

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
	if (!_config) {
		_config = loadConfig();
	}
	return _config;
}

export function resetConfigCache(): void {
	_config = null;
}
