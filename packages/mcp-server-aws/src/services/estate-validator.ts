// src/services/estate-validator.ts
// SIO-828: boot-time STS validation. For each configured estate, call
// sts:GetCallerIdentity through the per-estate AssumeRole provider. Results go
// into a process-lifetime health map exposed via aws_list_estates. The runtime
// always starts -- partial degradation is reported, not enforced (4-pillar
// pattern). Per-tool calls against a broken estate surface AccessDenied at
// call time; the validator just gives an earlier signal.

import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsConfig } from "../config/schemas.ts";
import { buildAssumedCredsProvider } from "./credentials.ts";

export interface EstateValidationResult {
	estate: string;
	ok: boolean;
	assumedArn?: string;
	error?: string;
	durationMs: number;
	validatedAt: string;
}

// Process-lifetime health map. The bootstrap populates this; aws_list_estates reads it.
let lastValidationResults: EstateValidationResult[] = [];

export function getEstateHealth(): EstateValidationResult[] {
	// Defensive copy: callers (aws_list_estates tool, tests) must not be able to
	// mutate the process-lifetime cache. Items are flat objects, so shallow
	// copy per element is enough.
	return lastValidationResults.map((r) => ({ ...r }));
}

export function _resetEstateHealthForTests(): void {
	lastValidationResults = [];
}

export async function validateEstates(config: AwsConfig): Promise<EstateValidationResult[]> {
	const entries = Object.entries(config.estates);
	const results = await Promise.all(
		entries.map(async ([estate, estateConfig]) => {
			const started = Date.now();
			try {
				const sts = new STSClient({
					region: config.region,
					credentials: buildAssumedCredsProvider(estateConfig, config.region),
					maxAttempts: 1,
				});
				const res = await sts.send(new GetCallerIdentityCommand({}));
				return {
					estate,
					ok: true,
					assumedArn: res.Arn,
					durationMs: Date.now() - started,
					validatedAt: new Date().toISOString(),
				};
			} catch (err) {
				return {
					estate,
					ok: false,
					error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
					durationMs: Date.now() - started,
					validatedAt: new Date().toISOString(),
				};
			}
		}),
	);
	lastValidationResults = results;
	return results;
}
