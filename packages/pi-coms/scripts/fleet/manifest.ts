// scripts/fleet/manifest.ts
// SIO-1653: the fleet manifest (deploy/fleet.yaml, gitignored; deploy/fleet.example.yaml
// committed). One hub per environment and every spoke declares its env: no
// cross-environment access, by construction (user decision 2026-09-06).
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const FleetEnvironmentSchema = z.enum(["dev", "stg", "prd"]);
export type FleetEnvironment = z.infer<typeof FleetEnvironmentSchema>;

const CidrSchema = z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, "expected a CIDR like 10.0.0.0/16");

export const HubSchema = z.object({
	profile: z.string().min(1),
	region: z.string().min(1),
	// Known after the first apply; when set, preflight verifies STS resolves to it
	// and the state bucket name is derived from it.
	account_id: z
		.string()
		.regex(/^\d{12}$/)
		.optional(),
	url: z.string().url(),
	port: z.number().int().positive().optional(),
	auth_path: z.string().min(1).optional(),
	dist_bucket: z.string().min(1).optional(),
	private_ip: z.string().min(1),
	subnet_id: z.string().min(1),
	allowed_cidrs: z.array(CidrSchema),
	// coms-net project namespace every spoke in this environment registers under.
	// One project per ENVIRONMENT, not one for the whole fleet: the registry is
	// read by more than the incident analyzer, and a shared "default" would
	// interleave dev and prd agents so a consumer could only tell them apart by
	// parsing name suffixes. That is the one place the standing no-cross-
	// environment rule (separate hubs, per-environment tokens, estate-suffix
	// routing) was not expressed. Omitted -> the module default "default", which
	// is what the pre-fleet dev deployment registered under.
	project: z.string().min(1).optional(),
	// Name of the environment variable holding an operator token for this hub's
	// API (rollout polling). Defaults to PI_COMS_NET_AUTH_TOKEN_<ENV>.
	token_env: z.string().min(1).optional(),
});
export type Hub = z.infer<typeof HubSchema>;

export const SpokeSchema = z.object({
	env: FleetEnvironmentSchema,
	profile: z.string().min(1),
	account_id: z
		.string()
		.regex(/^\d{12}$/)
		.optional(),
	subnet_id: z.string().min(1),
	vpc_cidr: CidrSchema,
	readonly_role: z.enum(["create", "adopt", "none"]),
	external_id: z.string().min(1).optional(),
	hosts_hub: z.boolean().optional(),
	agent_name: z.string().min(1).optional(),
	instance_type: z.string().min(1).optional(),
	pi_model: z.string().min(1).optional(),
});
export type Spoke = z.infer<typeof SpokeSchema>;

export const FleetManifestSchema = z.object({
	hubs: z.partialRecord(FleetEnvironmentSchema, HubSchema).refine((h) => Object.keys(h).length > 0, {
		message: "at least one hub",
	}),
	persona: z.object({ min_version: z.string().optional() }).optional(),
	defaults: z.object({
		region: z.string().min(1),
		instance_type: z.string().min(1),
		pi_model: z.string().min(1),
		external_id: z.partialRecord(FleetEnvironmentSchema, z.string().min(1)),
	}),
	spokes: z.record(z.string().regex(/^[a-z0-9-]+$/), SpokeSchema),
});
export type FleetManifest = z.infer<typeof FleetManifestSchema>;

export const DEFAULT_HUB_PORT = 8787;
export const DEFAULT_AUTH_PATH = "/pi-coms/auth";

export function hubFor(manifest: FleetManifest, env: FleetEnvironment): Hub {
	const hub = manifest.hubs[env];
	if (!hub) throw new Error(`no hub configured for environment "${env}"`);
	return hub;
}

export function externalIdFor(manifest: FleetManifest, name: string): string {
	const spoke = spokeFor(manifest, name);
	const id = spoke.external_id ?? manifest.defaults.external_id[spoke.env];
	if (!id) throw new Error(`spoke "${name}": no external_id for environment "${spoke.env}"`);
	return id;
}

export function spokeFor(manifest: FleetManifest, name: string): Spoke {
	const spoke = manifest.spokes[name];
	if (!spoke) throw new Error(`unknown spoke "${name}"; manifest lists ${Object.keys(manifest.spokes).join(", ")}`);
	return spoke;
}

export function spokeNames(manifest: FleetManifest, requested: string[]): string[] {
	if (requested.length === 0) return Object.keys(manifest.spokes);
	for (const name of requested) spokeFor(manifest, name);
	return requested;
}

// Cross-checks Zod cannot express: env to hub binding, hub-hosting spokes on the
// hub's profile, and CIDR isolation between environments.
export function validateManifest(manifest: FleetManifest): FleetManifest {
	const cidrOwner = new Map<string, FleetEnvironment>();
	for (const [env, hub] of Object.entries(manifest.hubs) as Array<[FleetEnvironment, Hub]>) {
		for (const cidr of hub.allowed_cidrs) {
			const owner = cidrOwner.get(cidr);
			if (owner && owner !== env) {
				throw new Error(
					`CIDR ${cidr} is allow-listed on both the ${owner} and ${env} hubs; no cross-environment access`,
				);
			}
			cidrOwner.set(cidr, env);
		}
	}
	for (const [name, spoke] of Object.entries(manifest.spokes)) {
		const hub = manifest.hubs[spoke.env];
		if (!hub) throw new Error(`spoke "${name}": env "${spoke.env}" has no hub in the manifest`);
		if (spoke.hosts_hub && spoke.profile !== hub.profile) {
			throw new Error(
				`spoke "${name}" hosts the ${spoke.env} hub but its profile "${spoke.profile}" is not the hub's "${hub.profile}"`,
			);
		}
		const owner = cidrOwner.get(spoke.vpc_cidr);
		if (owner && owner !== spoke.env) {
			throw new Error(
				`spoke "${name}" (${spoke.env}) has CIDR ${spoke.vpc_cidr}, which is allow-listed on the ${owner} hub`,
			);
		}
		if (!hub.allowed_cidrs.includes(spoke.vpc_cidr)) {
			throw new Error(`spoke "${name}": its VPC CIDR ${spoke.vpc_cidr} is not in the ${spoke.env} hub's allowed_cidrs`);
		}
		if (spoke.readonly_role === "adopt" && !(spoke.external_id ?? manifest.defaults.external_id[spoke.env])) {
			throw new Error(
				`spoke "${name}": adopt mode needs an external_id (the analyzer's ExternalId for this environment)`,
			);
		}
	}
	return manifest;
}

export function parseManifest(text: string): FleetManifest {
	return validateManifest(FleetManifestSchema.parse(parse(text)));
}

export function loadManifest(path: string): FleetManifest {
	return parseManifest(readFileSync(path, "utf-8"));
}
