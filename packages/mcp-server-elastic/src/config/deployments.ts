// src/config/deployments.ts
// SIO-649: Multi-deployment env parsing. Pattern: ELASTIC_<ID_UPPER_UNDERSCORED>_<SUFFIX>.

import type { DeploymentConfig } from "./schemas.js";

function envKey(id: string, suffix: string): string {
	return `ELASTIC_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function readEnv(id: string, suffix: string): string | undefined {
	const value = Bun.env[envKey(id, suffix)];
	return value && value.length > 0 ? value : undefined;
}

export function listDeploymentIds(): string[] {
	const raw = Bun.env.ELASTIC_DEPLOYMENTS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

// Builds a DeploymentConfig from per-deployment env vars. Returns null when URL is missing --
// the caller logs and skips instead of throwing, so one misconfigured deployment doesn't block others.
export function loadDeploymentFromEnv(id: string): DeploymentConfig | null {
	const url = readEnv(id, "URL");
	if (!url) return null;

	return {
		id,
		url,
		apiKey: readEnv(id, "API_KEY"),
		username: readEnv(id, "USERNAME"),
		password: readEnv(id, "PASSWORD"),
		caCert: readEnv(id, "CA_CERT"),
	};
}
