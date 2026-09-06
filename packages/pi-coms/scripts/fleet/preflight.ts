// scripts/fleet/preflight.ts
// SIO-1653: the decision table. Every row is a fact about one spoke that must
// hold before tokens, apply or rollout touch it. Nothing here mutates AWS.
import type { FleetAws } from "./aws.ts";
import { isExpiredCredential } from "./aws.ts";
import { DEFAULT_AUTH_PATH, type FleetManifest, hubFor, spokeFor, spokeNames } from "./manifest.ts";

export type PreflightRow = { spoke: string; check: string; ok: boolean; detail: string };

const ANALYZER_TRUST_HINT = /DevOpsAgentCoreRole|bedrock-agentcore/;

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
				const analyzer = trust.statements.some((st) => st.principals.some((p) => ANALYZER_TRUST_HINT.test(p)));
				row(
					"adopt role",
					analyzer,
					analyzer
						? `${trust.arn} trusts the analyzer; pi-coms adds one statement`
						: `${trust.arn} has no analyzer trust statement; confirm this is the analyzer's role before adopting`,
				);
			}
		} catch (error) {
			row("adopt role", false, String(error));
		}
	} else if (spoke.readonly_role === "create") {
		try {
			const trust = await aws.roleTrust(spoke.profile, region, "DevOpsAgentReadOnly");
			row(
				"create role",
				!trust || account === "",
				trust
					? `DevOpsAgentReadOnly already exists (${trust.arn}); use readonly_role: adopt`
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
