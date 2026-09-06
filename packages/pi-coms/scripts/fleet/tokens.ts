// scripts/fleet/tokens.ts
// SIO-1653: one principal per spoke in its own environment's hub directory,
// mirrored into the spoke root's gitignored tfvars so Terraform stays the single
// writer of the spoke's /pi-agent/auth-token parameter. The token value never
// leaves this module except through those two sinks.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { FleetAws } from "./aws.ts";
import { DEFAULT_AUTH_PATH, type FleetManifest, hubFor, spokeFor } from "./manifest.ts";
import { hasToken, renderTfvars, withToken } from "./render.ts";

export type PrincipalRecord = { token: string; kind: "agent"; names: string[] };

export function principalRecord(name: string, token: string): PrincipalRecord {
	return { token, kind: "agent", names: [name, `monitor-${name}`] };
}

export function mintToken(): string {
	return randomBytes(32).toString("hex");
}

export type EnsureResult = { spoke: string; minted: boolean; reason: string };

export async function ensureToken(
	manifest: FleetManifest,
	name: string,
	aws: FleetAws,
	opts: { accountsDir: string; rotate?: boolean; mint?: () => string },
): Promise<EnsureResult> {
	const spoke = spokeFor(manifest, name);
	const hub = hubFor(manifest, spoke.env);
	const principalPath = `${hub.auth_path ?? DEFAULT_AUTH_PATH}/${name}`;
	const tfvarsPath = path.join(opts.accountsDir, name, "terraform.tfvars");
	const existing = existsSync(tfvarsPath) ? readFileSync(tfvarsPath, "utf-8") : undefined;
	const onHub = await aws.parameterExists(hub.profile, hub.region, principalPath);
	if (onHub && existing && hasToken(existing) && !opts.rotate) {
		return { spoke: name, minted: false, reason: `principal ${principalPath} present and tfvars carries a token` };
	}
	const token = (opts.mint ?? mintToken)();
	await aws.putSecureParameter(hub.profile, hub.region, principalPath, JSON.stringify(principalRecord(name, token)));
	const tfvars = withToken(existing ?? renderTfvars(manifest, name), token);
	// `tokens ensure` may run before the first `render`; the root directory is created here.
	mkdirSync(path.dirname(tfvarsPath), { recursive: true });
	writeFileSync(tfvarsPath, tfvars, { mode: 0o600 });
	return {
		spoke: name,
		minted: true,
		reason: opts.rotate
			? `rotated ${principalPath}; apply then rollout ${name} to pick it up`
			: `minted ${principalPath}; written to ${tfvarsPath}`,
	};
}
