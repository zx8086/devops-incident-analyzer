// shared/src/kill-switch.ts
import { existsSync } from "node:fs";

export interface KillSwitchConfig {
	envVar?: string;
	sentinelPath?: string;
}

const DEFAULT_ENV_VAR = "AGENT_KILL_SWITCH";

export class KillSwitchError extends Error {
	constructor() {
		super("Agent execution halted: kill switch is active");
		this.name = "KillSwitchError";
	}
}

export function isKillSwitchActive(config?: KillSwitchConfig): boolean {
	const envVar = config?.envVar ?? DEFAULT_ENV_VAR;
	const envValue = process.env[envVar];
	if (envValue === "true" || envValue === "1") return true;

	if (config?.sentinelPath && existsSync(config.sentinelPath)) return true;

	return false;
}
