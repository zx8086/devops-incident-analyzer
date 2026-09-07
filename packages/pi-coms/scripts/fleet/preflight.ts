// scripts/fleet/preflight.ts
// SIO-1653: the decision table. Every row is a fact about one spoke that must
// hold before tokens, apply or rollout touch it. Nothing here mutates AWS.
import type { FleetAws } from "./aws.ts";
import { isExpiredCredential } from "./aws.ts";
import { DEFAULT_AUTH_PATH, type FleetManifest, hubFor, spokeFor, spokeNames } from "./manifest.ts";

export type PreflightRow = { spoke: string; check: string; ok: boolean; detail: string };

// Principals that legitimately own a DevOpsAgentReadOnly this fleet may adopt.
// The check exists to stop `adopt` from touching a same-named role belonging to
// something else -- clobbering its trust policy would silently cut off whatever
// depends on it (the risk the feasibility doc rates "trust-policy edit on a prd
// DevOpsAgentReadOnly clobbers the analyzer's access").
//
// Two legitimate owners, hence two patterns:
//   - the incident analyzer, which assumes the role from AgentCore; and
//   - `pi-agent-agent`, the spoke's OWN instance role. The dev accounts
//     (352896877281, 120999474587) were deployed this way before the fleet CLI
//     existed: the role trusts the local pi-agent with the
//     `devops-agent-*-access` ExternalId and no analyzer statement. That is the
//     role this fleet is meant to adopt, so refusing it was a false negative.
//
// Deliberately still a NARROW allow-list, not a blanket pass: an unrecognised
// principal keeps failing preflight, on dev and prd alike.
// The Project tag this module stamps on every resource it creates.
const PI_COMS_STACK = "pi-coms-net";

const ADOPTABLE_TRUST_HINT = /DevOpsAgentCoreRole|bedrock-agentcore|role\/pi-agent-agent/;

export async function preflightSpoke(manifest: FleetManifest, name: string, aws: FleetAws): Promise<PreflightRow[]> {
	const spoke = spokeFor(manifest, name);
	const hub = hubFor(manifest, spoke.env);
	const region = manifest.defaults.region;
	const rows: PreflightRow[] = [];
	const row = (check: string, ok: boolean, detail: string) => rows.push({ spoke: name, check, ok, detail });

	// 1. Credentials. An expired portal session stops everything else for this
	// spoke; the tool cannot refresh it.
	let account = "";
	try {
		const id = await aws.callerIdentity(spoke.profile, region);
		account = id.account;
		if (spoke.account_id && spoke.account_id !== id.account) {
			row(
				"credentials",
				false,
				`profile ${spoke.profile} resolves to account ${id.account}, manifest says ${spoke.account_id}`,
			);
			return rows;
		}
		row("credentials", true, `profile ${spoke.profile} -> account ${id.account}`);
	} catch (error) {
		const reason = isExpiredCredential(error)
			? "expired or invalid credentials; re-paste the portal session"
			: String(error);
		row("credentials", false, `profile ${spoke.profile}: ${reason}`);
		return rows;
	}

	// 2. Hub-side principal for this spoke (minted by `fleet tokens ensure`).
	try {
		const principal = `${hub.auth_path ?? DEFAULT_AUTH_PATH}/${name}`;
		const present = await aws.parameterExists(hub.profile, hub.region, principal);
		row(
			"hub principal",
			present,
			present
				? `${principal} present on the ${spoke.env} hub`
				: `${principal} missing; run: fleet tokens ensure ${name}`,
		);
	} catch (error) {
		row(
			"hub principal",
			false,
			`${hub.profile}: ${isExpiredCredential(error) ? "expired or invalid credentials" : String(error)}`,
		);
	}

	// 3. Network: the subnet routes to a transit gateway and its VPC CIDR is on
	// this environment's hub allow-list (and matches the manifest).
	try {
		const routes = await aws.subnetRoutes(spoke.profile, region, spoke.subnet_id);
		row(
			"tgw route",
			routes.transitGatewayRoute,
			routes.transitGatewayRoute
				? `${spoke.subnet_id} routes via a transit gateway`
				: `${spoke.subnet_id} has no transit gateway route; the network team owns the attachment`,
		);
		// Judge the CIDR AWS reports for the subnet, not the manifest's claim.
		const observed = routes.cidr || spoke.vpc_cidr;
		const listed = hub.allowed_cidrs.includes(observed);
		row(
			"hub allow-list",
			listed,
			listed
				? `${observed} allow-listed on the ${spoke.env} hub`
				: `${observed} (subnet) is not in the ${spoke.env} hub allowed_cidrs`,
		);
		if (routes.cidr && routes.cidr !== spoke.vpc_cidr && !hub.allowed_cidrs.includes(routes.cidr)) {
			row("manifest cidr", false, `manifest vpc_cidr ${spoke.vpc_cidr} differs from the subnet's ${routes.cidr}`);
		}
	} catch (error) {
		row("tgw route", false, String(error));
	}

	// 4. Organization: the distribution bucket policy is org-scoped.
	try {
		const spokeOrg = await aws.organizationId(spoke.profile, region);
		const hubOrg = await aws.organizationId(hub.profile, hub.region);
		if (!spokeOrg || !hubOrg) row("organization", true, "org id not readable from this profile (skipped)");
		else
			row(
				"organization",
				spokeOrg === hubOrg,
				spokeOrg === hubOrg
					? `same organization ${hubOrg}`
					: `spoke org ${spokeOrg} differs from hub org ${hubOrg}; bucket reads will be denied`,
			);
	} catch (error) {
		row("organization", false, String(error));
	}

	// 5. Bedrock inference profile visible in the region.
	const model = spoke.pi_model ?? manifest.defaults.pi_model;
	try {
		const visible = await aws.inferenceProfileVisible(spoke.profile, region, model);
		row(
			"bedrock model",
			visible,
			visible
				? `${model} visible in ${region}`
				: `${model} not visible in ${region}; enable model access in the console`,
		);
	} catch (error) {
		row("bedrock model", false, String(error));
	}

	// 6. Adopt mode: the analyzer's role exists and keeps its own trust statement.
	if (spoke.readonly_role === "adopt") {
		try {
			const trust = await aws.roleTrust(spoke.profile, region, "DevOpsAgentReadOnly");
			if (!trust)
				row("adopt role", false, "DevOpsAgentReadOnly does not exist in this account; use readonly_role: create");
			else {
				const adoptable = trust.statements.some((st) => st.principals.some((p) => ADOPTABLE_TRUST_HINT.test(p)));
				row(
					"adopt role",
					adoptable,
					adoptable
						? `${trust.arn} trusts the analyzer or this account's pi-agent; pi-coms adds one statement`
						: `${trust.arn} trusts neither the analyzer nor pi-agent-agent; confirm whose role this is before adopting`,
				);
			}
		} catch (error) {
			row("adopt role", false, String(error));
		}
	} else if (spoke.readonly_role === "create") {
		try {
			const trust = await aws.roleTrust(spoke.profile, region, "DevOpsAgentReadOnly");
			// "create" used to require the role to be ABSENT, which refused the
			// commonest steady state: a fleet pi-coms deployed itself, where the
			// role exists AND terraform already manages it. Both modes then
			// blocked -- `create` because it exists, `adopt` because adopt stops
			// managing the vendored policies and would destroy 207 read actions
			// (observed on eu-oit-dev / eu-shared-services-dev, 2026-09-07).
			//
			// Ownership is what the check actually needs, and the role's own tags
			// answer it: this module stamps ManagedBy=terraform + Project=pi-coms-net
			// on everything it creates. A role carrying both is ours to keep
			// managing; one without them belongs to something else and `adopt` is
			// the right mode. GetRole already returns tags, so this costs no extra
			// call.
			const ours = trust !== undefined && trust.tags.ManagedBy === "terraform" && trust.tags.Project === PI_COMS_STACK;
			row(
				"create role",
				!trust || ours || account === "",
				trust
					? ours
						? `${trust.arn} already exists and is managed by this fleet; terraform keeps it`
						: `DevOpsAgentReadOnly already exists (${trust.arn}) and is NOT tagged as this fleet's; use readonly_role: adopt`
					: "DevOpsAgentReadOnly absent, will be created",
			);
		} catch (error) {
			row("create role", false, String(error));
		}
	}
	return rows;
}

export async function preflight(manifest: FleetManifest, names: string[], aws: FleetAws): Promise<PreflightRow[]> {
	const rows: PreflightRow[] = [];
	for (const name of spokeNames(manifest, names)) rows.push(...(await preflightSpoke(manifest, name, aws)));
	return rows;
}

export function formatPreflight(rows: PreflightRow[]): string {
	const w = Math.max(...rows.map((r) => r.spoke.length), 5);
	const c = Math.max(...rows.map((r) => r.check.length), 5);
	return rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.spoke.padEnd(w)} ${r.check.padEnd(c)} ${r.detail}`).join("\n");
}

export function preflightPassed(rows: PreflightRow[]): boolean {
	return rows.every((r) => r.ok);
}
