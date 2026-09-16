// tests/fleet-render.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseManifest } from "../scripts/fleet/manifest.ts";
import { hasToken, renderRoot, withToken } from "../scripts/fleet/render.ts";

const EXAMPLE = readFileSync(path.join(import.meta.dir, "..", "deploy", "fleet.example.yaml"), "utf-8");
const manifest = parseManifest(EXAMPLE);
const IDENTIFIER = /subnet-|10\.\d+\.\d+\.\d+|\b\d{12}\b|<set by/;

describe("fleet root renderer (SIO-1653)", () => {
	// SIO-1736: the monitor reads its crons in the host zone (UTC on these
	// hosts), so a wall-clock digest time has to be rendered in, not hand-set on
	// the host -- an instance replacement wipes ~/.coms-env.local.
	test("monitor_tz and monitor_daily_cron render only when the manifest sets them", () => {
		expect(renderRoot(manifest, "eu-oit-dev")["main.tf"]).not.toContain("monitor_tz");
		const tuned = parseManifest(
			EXAMPLE.replace(/^(defaults:\n)/m, '$1  monitor_tz: Europe/Amsterdam\n  monitor_daily_cron: "15 8 * * *"\n'),
		);
		const main = renderRoot(tuned, "eu-oit-dev")["main.tf"] ?? "";
		expect(main).toContain('monitor_tz           = "Europe/Amsterdam"');
		// Quoted in HCL: the value carries globs, and an unquoted one broke a
		// production monitor when set by hand ("not a valid identifier").
		expect(main).toContain('monitor_daily_cron   = "15 8 * * *"');
	});

	// SIO-1746: the checkpoint bucket policy was hand-added to the generated
	// roots by SIO-1745, so `just fleet render` silently deleted it. It is
	// emitted by the generator now; these assertions stop it regressing to a
	// hand-edit.
	test("a hub-hosting root emits the checkpoint write grant and lifecycle", () => {
		const main = renderRoot(manifest, "eu-shared-services-dev")["main.tf"] ?? "";

		// A spoke writes its checkpoint CROSS-ACCOUNT, which needs a
		// resource-based Allow as well as the spoke's identity grant.
		expect(main).toContain('Sid       = "OrgWriteCheckpointState"');
		// Superseded bodies expire; manifests never do.
		expect(main).toContain('id     = "expire-superseded-checkpoint-dbs"');
		expect(main).toContain('prefix = "checkpoint-db/"');
		expect(main).not.toContain('prefix = "state/"');

		// aws:PrincipalArn is the ROLE arn, never the sts session arn, and is
		// single-valued: ForAllValues on it is vacuously true when the key is
		// absent, which silently matches everything.
		expect(main).toContain('ArnLike      = { "aws:PrincipalArn" = "arn:aws:iam::*:role/*-agent" }');
		// Strip comments before the negative assertions: the rendered file
		// explains WHY sts:: and ForAllValues are wrong, so a naive substring
		// check matches the warning rather than a real condition.
		const code = main
			.split("\n")
			.filter((l) => !l.trim().startsWith("//"))
			.join("\n");
		expect(code).not.toContain("arn:aws:sts::");
		expect(code).not.toContain("ForAllValues");
	});

	// The fleet is a star: operators talk to the hub, the hub talks to the
	// spokes, and spokes never talk to each other. There is no tenancy boundary
	// between spokes, so no cross-spoke read Deny -- an earlier attempt at one
	// was vacuous (it exempted the whole *-agent role class) and the NotResource
	// form that fixed that also denied fleet/, breaking bundle convergence on
	// prd. Writes stay scoped by the spoke's own identity policy.
	test("no cross-spoke read Deny: spokes are one fleet, not tenants", () => {
		const main = renderRoot(manifest, "eu-shared-services-dev")["main.tf"] ?? "";
		expect(main).not.toContain("DenyCrossSpokeStateRead");
		expect(main).not.toContain("NotResource");
	});

	test("a non-hub spoke root carries no bucket policy at all", () => {
		const main = renderRoot(manifest, "eu-oit-dev")["main.tf"] ?? "";
		expect(main).not.toContain("OrgWriteCheckpointState");
		expect(main).not.toContain("aws_s3_bucket_lifecycle_configuration");
	});

	test("a dev spoke root uses create mode and takes every identifier from tfvars", () => {
		const root = renderRoot(manifest, "eu-oit-dev");
		expect(root["main.tf"]).toContain('readonly_role_mode   = "create"');
		expect(root["main.tf"]).toContain("readonly_role        = true");
		expect(root["main.tf"]).toContain('default     = "devops-agent-dev-access"');
		expect(root["main.tf"]).not.toContain("import {");
		expect(root["main.tf"]).not.toMatch(IDENTIFIER);
		expect(root["backend.tf"]).not.toMatch(IDENTIFIER);
		expect(root["backend.tf"]).toContain('key          = "accounts/eu-oit-dev.tfstate"');
		expect(root["backend.hcl"]).toContain('bucket  = "pi-coms-tfstate-111111111111"');
		expect(root["backend.hcl"]).toContain('profile = "eu-shared-services-dev"');
		expect(root["terraform.tfvars"]).toContain('agent_subnet_id = "subnet-0dev0oit000000000"');
		expect(root["terraform.tfvars"]).toContain('hub_url         = "http://10.0.0.10:8787"');
		expect(root["terraform.tfvars"]).toContain('dist_bucket     = "pi-coms-dist-111111111111"');
		expect(hasToken(root["terraform.tfvars"])).toBe(false);
	});

	test("a hub-hosting root renders the bucket, the hub module and the hub outputs", () => {
		const root = renderRoot(manifest, "eu-shared-services-prd");
		expect(root["main.tf"]).toContain('module "hub"');
		expect(root["main.tf"]).toContain('resource "aws_s3_bucket" "dist"');
		expect(root["main.tf"]).toContain("aws:PrincipalOrgID");
		expect(root["main.tf"]).toContain("hub_url              = module.hub.hub_url");
		expect(root["main.tf"]).toContain('output "hub_url"');
		expect(root["terraform.tfvars"]).toContain('hub_private_ip  = "10.10.0.10"');
		expect(root["terraform.tfvars"]).toContain('allowed_cidrs   = ["10.10.0.0/23"');
		expect(root["terraform.tfvars"]).not.toContain("10.0.0.0/23"); // never a dev CIDR on the prd hub
	});

	test("an adopt root imports the existing role and passes the analyzer's ExternalId", () => {
		const root = renderRoot(manifest, "eu-oit-prd");
		expect(root["main.tf"]).toContain('readonly_role_mode   = "adopt"');
		expect(root["main.tf"]).toContain("to = module.agent.aws_iam_role.devops_readonly[0]");
		expect(root["main.tf"]).toContain('id = "DevOpsAgentReadOnly"');
		expect(root["main.tf"]).toContain('default     = "devops-agent-prod-access"');
		expect(root["main.tf"]).toContain('Environment = "prd"');
	});

	test("re-rendering keeps a minted token; withToken replaces the placeholder", () => {
		const first = renderRoot(manifest, "eu-oit-dev")["terraform.tfvars"];
		const minted = withToken(first, "abc123");
		expect(hasToken(minted)).toBe(true);
		const again = renderRoot(manifest, "eu-oit-dev", minted)["terraform.tfvars"];
		expect(again).toContain('coms_auth_token = "abc123"');
		expect(again.split("\n").filter((l) => l.startsWith("coms_auth_token"))).toHaveLength(1);
	});

	// SIO-1759: the org's required tags are values an operator supplies; they go to
	// the gitignored tfvars and reach resources through the provider default_tags.
	test("org_tags render into tfvars only, merged under the pi-coms markers", () => {
		const bare = renderRoot(manifest, "eu-oit-prd");
		expect(bare["main.tf"]).toContain("tags = merge(var.org_tags, {");
		expect(bare["main.tf"]).toContain('variable "org_tags" {');
		expect(bare["terraform.tfvars"]).not.toContain("org_tags");

		const tagged = parseManifest(
			EXAMPLE.replace(
				/^(defaults:\n)/m,
				"$1  org_tags:\n    CostCenter: CC-DEFAULT\n    Owner: team-default\n",
			).replace(/^( {2}eu-oit-prd:\n)/m, "$1    org_tags:\n      Owner: team-oit\n"),
		);
		const oit = renderRoot(tagged, "eu-oit-prd");
		expect(oit["terraform.tfvars"]).toContain('org_tags = {\n  "CostCenter" = "CC-DEFAULT"\n  "Owner" = "team-oit"\n}');
		expect(renderRoot(tagged, "eu-oit-dev")["terraform.tfvars"]).toContain('"Owner" = "team-default"');
		// Values never reach the committed root.
		expect(oit["main.tf"]).not.toContain("CC-DEFAULT");
		expect(oit["main.tf"]).not.toContain("team-oit");
	});

	test("org_tags may not override a pi-coms tag", () => {
		const text = EXAMPLE.replace(/^(defaults:\n)/m, "$1  org_tags:\n    Project: hijacked\n");
		expect(() => parseManifest(text)).toThrow("org_tags must not set a pi-coms tag");
	});

	test("every manifest spoke renders a root whose committed files carry no identifiers", () => {
		for (const name of Object.keys(manifest.spokes)) {
			const root = renderRoot(manifest, name);
			expect({ name, clean: !IDENTIFIER.test(root["main.tf"]) && !IDENTIFIER.test(root["backend.tf"]) }).toEqual({
				name,
				clean: true,
			});
		}
	});
});
