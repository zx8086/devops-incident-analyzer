// src/services/estate-validator.ts
// SIO-828: boot-time STS validation. For each configured estate, call
// sts:GetCallerIdentity through the per-estate AssumeRole provider so any
// misconfigured trust policy fails the deploy loudly instead of surfacing as
// "tool returned no results" hours later.

import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsConfig } from "../config/schemas.ts";
import { buildAssumedCredsProvider } from "./credentials.ts";

export interface EstateValidationResult {
	estate: string;
	ok: boolean;
	assumedArn?: string;
	error?: string;
	durationMs: number;
}

export async function validateEstates(config: AwsConfig): Promise<EstateValidationResult[]> {
	const entries = Object.entries(config.estates);
	// Run in parallel: O(slowest) not O(sum). Three estates ~ 300-600ms total.
	return Promise.all(
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
				};
			} catch (err) {
				return {
					estate,
					ok: false,
					error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
					durationMs: Date.now() - started,
				};
			}
		}),
	);
}
