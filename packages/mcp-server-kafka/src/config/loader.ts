// src/config/loader.ts

import { defaults } from "./defaults.ts";
import { envMapping } from "./envMapping.ts";
import { toBool, toNumber } from "./helpers.ts";
import { type AppConfig, configSchema } from "./schemas.ts";

const booleanPaths = new Set([
	"kafka.allowWrites",
	"kafka.allowDestructive",
	"schemaRegistry.enabled",
	"ksql.enabled",
	"telemetry.enabled",
]);

const numberPaths = new Set([
	"kafka.consumeMaxMessages",
	"kafka.consumeTimeoutMs",
	"transport.port",
	"transport.idleTimeout",
]);

function setNested(obj: Record<string, Record<string, unknown>>, dotPath: string, value: unknown): void {
	const [section, key] = dotPath.split(".") as [string, string];
	const target = obj[section];
	if (target) {
		target[key] = value;
	}
}

export function loadConfig(): AppConfig {
	// Deep clone defaults into a mutable structure
	const merged: Record<string, Record<string, unknown>> = {};
	for (const [section, values] of Object.entries(defaults)) {
		merged[section] = { ...values };
	}

	for (const [envVar, dotPath] of Object.entries(envMapping)) {
		const raw = Bun.env[envVar];
		if (raw === undefined) continue;

		if (booleanPaths.has(dotPath)) {
			const [section, key] = dotPath.split(".") as [string, string];
			const fallback = defaults[section as keyof typeof defaults]?.[key as never] as boolean;
			setNested(merged, dotPath, toBool(raw, fallback));
		} else if (numberPaths.has(dotPath)) {
			const [section, key] = dotPath.split(".") as [string, string];
			const fallback = defaults[section as keyof typeof defaults]?.[key as never] as number;
			setNested(merged, dotPath, toNumber(raw, fallback));
		} else {
			setNested(merged, dotPath, raw);
		}
	}

	return configSchema.parse(merged);
}
