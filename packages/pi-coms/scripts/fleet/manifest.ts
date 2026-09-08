// scripts/fleet/manifest.ts
// SIO-1653: the fleet manifest (deploy/fleet.yaml, gitignored; deploy/fleet.example.yaml
// committed). Every spoke declares its env and names its hub: no
// cross-environment access, by construction (user decision 2026-09-06).
//
// SIO-1666: hubs are keyed by SELECTOR (the AWS profile), not by environment.
// A hub's identity is the account it lives in -- the fleet is one hub per
// account serving several spoke accounts in a domain, and `dev`/`prd` only
// worked while eu-shared-services happened to own both. A second domain's prd
// hub had nowhere to live under the old key. `environment` survives as an
// ATTRIBUTE (external_id and the persona still care about it), never as identity.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const FleetEnvironmentSchema = z.enum(["dev", "stg", "prd"]);
export type FleetEnvironment = z.infer<typeof FleetEnvironmentSchema>;

// A hub key: the AWS profile/selector an operator already types for AWS.
export const HubKeySchema = z.string().regex(/^[a-z0-9-]+$/, "hub keys look like an AWS profile, e.g. eu-shared-services-prd");
export type HubKey = z.infer<typeof HubKeySchema>;

const CidrSchema = z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, "expected a CIDR like 10.0.0.0/16");

export const HubSchema = z.object({
	profile: z.string().min(1),
	region: z.string().min(1),
	// SIO-1666: the environment this hub serves. An ATTRIBUTE, not the key --
	// external_id is still per environment and the persona still cares, but two
	// hubs may now share one environment.
	environment: FleetEnvironmentSchema,
	// SIO-1666: the local port `just hub-tunnel` binds for this hub, explicit.
	// It used to be derived (+1 prd, +2 stg), which is the environment assumption
	// in another costume: two prd hubs would derive the SAME local port and the
	// second tunnel would silently bind nothing (the class of failure #701 fixed
	// once for dev-vs-prd). Required, so a new hub cannot collide by omission.
	local_port: z.number().int().positive(),
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
	// API (rollout polling). SIO-1666: REQUIRED. It used to default to
	// PI_COMS_NET_AUTH_TOKEN_<ENV>, which collides the moment two hubs share an
	// environment -- both would read one variable and the second would
	// authenticate against the wrong hub's token.
	token_env: z.string().min(1),
});
export type Hub = z.infer<typeof HubSchema>;

export const SpokeSchema = z.object({
	env: FleetEnvironmentSchema,
	// SIO-1666: which hub this spoke registers with, by hub key. EXPLICIT -- it
	// used to be inherited from `env`, which is exactly what capped the fleet at
	// one hub per environment. This single field is what unlocks the rest.
	hub: HubKeySchema,
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
	// AWS Organizations id scoping distribution-bucket reads. render used to emit
	// a "<set: ...>" placeholder here and expect a human to patch the generated
	// tfvars; every re-render silently reverted it, and an apply then wrote the
	// literal placeholder into the bucket policy's aws:PrincipalOrgID condition.
	// Nothing matches that string, so every CROSS-ACCOUNT bundle read 403s while
	// the hub account (reading its own bucket) keeps working -- a spoke that
	// cannot update, with no error until pi-coms-update fails on the host.
	org_id: z
		.string()
		.regex(/^o-[a-z0-9]+$/, 'org_id must look like "o-abc123xyz"')
		.optional(),
	// SIO-1666: keyed by selector (AWS profile), not environment.
	hubs: z.record(HubKeySchema, HubSchema).refine((h) => Object.keys(h).length > 0, {
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

// SIO-1666: look a hub up by its KEY (selector). Accepts an account id too, since
// the spec keeps account_id as the canonical identity and an operator may have
// only that to hand.
export function hubFor(manifest: FleetManifest, selector: string): Hub {
	const direct = manifest.hubs[selector];
	if (direct) return direct;
	const byAccount = Object.values(manifest.hubs).find((h) => h.account_id === selector);
	if (byAccount) return byAccount;
	throw new Error(`unknown hub "${selector}"; manifest lists ${Object.keys(manifest.hubs).join(", ")}`);
}

// The hub a spoke registers with, by its explicit binding.
export function hubForSpoke(manifest: FleetManifest, name: string): Hub {
	return hubFor(manifest, spokeFor(manifest, name).hub);
}

// The hub key a spoke is bound to (callers that need the key, not the hub).
export function hubKeyForSpoke(manifest: FleetManifest, name: string): string {
	return spokeFor(manifest, name).hub;
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

// Cross-checks Zod cannot express: the spoke-to-hub binding, hub-hosting spokes
// on the hub's profile, CIDR isolation between HUBS, and unique local ports.
//
// SIO-1666: isolation regroups per hub rather than per environment. The rule is
// unchanged -- a spoke subnet belongs to exactly one hub -- but it is now stated
// in terms of the thing that owns the subnet. Errors name hubs, because "the prd
// hub" stops identifying anything once two exist.
export function validateManifest(manifest: FleetManifest): FleetManifest {
	const hubEntries = Object.entries(manifest.hubs) as Array<[string, Hub]>;

	// Two hubs sharing a local port means the second tunnel binds nothing.
	const portOwner = new Map<number, string>();
	for (const [key, hub] of hubEntries) {
		const owner = portOwner.get(hub.local_port);
		if (owner) {
			throw new Error(
				`hubs "${owner}" and "${key}" both use local_port ${hub.local_port}; give each hub its own so their tunnels can run side by side`,
			);
		}
		portOwner.set(hub.local_port, key);
	}

	const cidrOwner = new Map<string, string>();
	for (const [key, hub] of hubEntries) {
		for (const cidr of hub.allowed_cidrs) {
			const owner = cidrOwner.get(cidr);
			if (owner && owner !== key) {
				throw new Error(`CIDR ${cidr} is allow-listed on both the "${owner}" and "${key}" hubs; a subnet has one hub`);
			}
			cidrOwner.set(cidr, key);
		}
	}

	for (const [name, spoke] of Object.entries(manifest.spokes)) {
		const hub = manifest.hubs[spoke.hub];
		if (!hub) {
			throw new Error(
				`spoke "${name}": hub "${spoke.hub}" is not in the manifest; hubs are ${Object.keys(manifest.hubs).join(", ")}`,
			);
		}
		// The standing no-cross-environment rule, now checkable directly rather
		// than implied by the key: a dev spoke must not bind a prd hub.
		if (spoke.env !== hub.environment) {
			throw new Error(
				`spoke "${name}" is ${spoke.env} but hub "${spoke.hub}" serves ${hub.environment}; no cross-environment access`,
			);
		}
		if (spoke.hosts_hub && spoke.profile !== hub.profile) {
			throw new Error(
				`spoke "${name}" hosts hub "${spoke.hub}" but its profile "${spoke.profile}" is not the hub's "${hub.profile}"`,
			);
		}
		const owner = cidrOwner.get(spoke.vpc_cidr);
		if (owner && owner !== spoke.hub) {
			throw new Error(
				`spoke "${name}" has CIDR ${spoke.vpc_cidr}, which is allow-listed on the "${owner}" hub, not its own "${spoke.hub}"`,
			);
		}
		if (!hub.allowed_cidrs.includes(spoke.vpc_cidr)) {
			throw new Error(`spoke "${name}": its VPC CIDR ${spoke.vpc_cidr} is not in hub "${spoke.hub}"'s allowed_cidrs`);
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
