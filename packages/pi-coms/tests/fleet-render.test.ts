// tests/fleet-render.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseManifest } from "../scripts/fleet/manifest.ts";
import { hasToken, renderRoot, renderTfvars, withToken } from "../scripts/fleet/render.ts";

const EXAMPLE = readFileSync(path.join(import.meta.dir, "..", "deploy", "fleet.example.yaml"), "utf-8");
const manifest = parseManifest(EXAMPLE);
const IDENTIFIER = /subnet-|10\.\d+\.\d+\.\d+|\b\d{12}\b|<set by/;

// SIO-1821: the topic arn belongs to a HUB, not to fleet-wide defaults -- a
// single default renders the prd topic into dev spokes. These helpers set it on
// the PRD hub only, so a dev spoke bound to the dev hub must come back empty.
const PRD_ARN = "arn:aws:sns:eu-central-1:111111111111:pi-coms-monitor-reports";
function withHubArn(yaml: string): string {
	return yaml
		.replace(/^(defaults:\n)/m, "$1  monitor_report_email: true\n")
		.replace(/^( {2}eu-shared-services-prd:\n)/m, `$1    monitor_report_sns_topic_arn: "${PRD_ARN}"\n`);
}

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

	test("an org tag may be empty (the rule checks keys, not values)", () => {
		const text = EXAMPLE.replace(/^(defaults:\n)/m, '$1  org_tags:\n    BlueprintID: ""\n');
		expect(renderRoot(parseManifest(text), "eu-oit-prd")["terraform.tfvars"]).toContain('"BlueprintID" = ""');
	});

	// SIO-1821: the report topic renders only when the manifest asks for it, so
	// an unset manifest produces exactly today's roots.
	test("no monitor_report_email renders no SNS topic anywhere", () => {
		for (const name of Object.keys(manifest.spokes)) {
			const root = renderRoot(manifest, name);
			expect(root["main.tf"]).not.toContain("aws_sns_topic");
			expect(root["main.tf"]).not.toContain("monitor_report_sns_topic_arn");
		}
	});

	// The optional blocks are template interpolations, and an interpolation on its
	// own line contributes a newline even when it renders "". That made every
	// committed root gain a blank line on the next `just fleet render` -- churn in
	// eight generated files for a flag nobody had turned on.
	test("the OFF case introduces no blank-line churn", () => {
		for (const name of Object.keys(manifest.spokes)) {
			const main = renderRoot(manifest, name)["main.tf"];
			expect(main).not.toContain("\n\n\n");
		}
	});

	test("monitor_report_email renders the topic in EVERY hub root, and a tfvar elsewhere", () => {
		const text = EXAMPLE.replace(/^(defaults:\n)/m, "$1  monitor_report_email: true\n");
		const tagged = parseManifest(text);
		// The example manifest has one hub-hosting spoke per ENVIRONMENT, so this
		// must hold for each of them, not just the first one found.
		const hubRoots = Object.keys(tagged.spokes).filter((n) => tagged.spokes[n]?.hosts_hub === true);
		expect(hubRoots.length).toBeGreaterThan(0);

		for (const name of hubRoots) {
			const hub = renderRoot(tagged, name)["main.tf"];
			expect(hub).toContain('resource "aws_sns_topic" "monitor_reports"');
			expect(hub).toContain('resource "aws_sns_topic_policy" "monitor_reports"');
			// In the hub account the agent gets the topic by REFERENCE, not a tfvar.
			expect(hub).toContain("monitor_report_sns_topic_arn = aws_sns_topic.monitor_reports.arn");
		}

		for (const name of Object.keys(tagged.spokes)) {
			if (hubRoots.includes(name)) continue;
			const spoke = renderRoot(tagged, name)["main.tf"];
			// Cross-account: a value from tfvars, never a reference into another
			// account's state.
			expect(spoke).not.toContain('resource "aws_sns_topic"');
			expect(spoke).toContain("monitor_report_sns_topic_arn = var.monitor_report_sns_topic_arn");
			expect(spoke).toContain('variable "monitor_report_sns_topic_arn"');
		}
	});

	// SIO-1821 follow-up (Greptile P1, verified): the first version scoped the
	// policy to a var.monitor_report_publisher_arns list that nothing populated.
	// It defaults to [], which renders Principal.AWS = [] -- a policy that
	// authorizes NOBODY -- and publishReportToSns swallows the resulting 403, so
	// the feature would have looked enabled and delivered no email at all.
	// No spoke carries an account_id in the manifest (only hubs do), so a derived
	// ARN list would be empty or wrong; the policy is scoped by CONDITION, the
	// same shape the dist bucket already uses.
	test("the topic policy actually authorizes the spoke monitors", () => {
		const text = EXAMPLE.replace(/^(defaults:\n)/m, "$1  monitor_report_email: true\n");
		const tagged = parseManifest(text);
		const hubRoot = Object.keys(tagged.spokes).find((n) => tagged.spokes[n]?.hosts_hub === true);
		if (!hubRoot) throw new Error("the example manifest has no hosts_hub spoke");
		const hub = renderRoot(tagged, hubRoot)["main.tf"];

		// The bug: a principal list nothing populates. Asserted on the CODE, not
		// on prose -- the explanatory comment names the failure it prevents.
		const code = hub
			.split("\n")
			.filter((l) => !l.trim().startsWith("//"))
			.join("\n");
		expect(code).not.toContain("monitor_report_publisher_arns");
		expect(code).not.toContain("AWS = []");
		expect(code).toContain('Principal = "*"');

		// Both halves of the scope must be present: an org check alone would let
		// any principal in the org publish, and the ARN pattern alone would let
		// another org's matching role in.
		expect(code).toContain('"aws:PrincipalOrgID" = var.org_id');

		// The condition must match the role the monitor ACTUALLY publishes as.
		// The bootstrap sets AWS_PROFILE=devops-readonly whenever
		// READONLY_ROLE_ARN is present, so the whole piagent workload assumes
		// DevOpsAgentReadOnly -- which is also where the sns:Publish grant lives.
		// The first version reused the dist bucket's "*-agent" pattern, which
		// guards the INSTANCE role writing checkpoints: right there, and wrong
		// here, because it rejects every intended publisher. Asserted by matching
		// the rendered pattern against real role names rather than by string
		// equality, so it fails if the pattern stops covering the real role.
		const arnLike = /"aws:PrincipalArn" = "([^"]+)"/.exec(code)?.[1];
		expect(arnLike).toBeDefined();
		const toRe = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
		expect(toRe(arnLike as string).test("arn:aws:iam::123456789012:role/DevOpsAgentReadOnly")).toBe(true);
		// And must not silently widen to every role in the org.
		expect(toRe(arnLike as string).test("arn:aws:iam::123456789012:role/SomeOtherRole")).toBe(false);
	});

	// The topic name must never carry an account id or address: committed roots
	// are identifier-free by design (the IDENTIFIER guard below covers this too,
	// but naming it here says why).
	test("the rendered topic carries no identifiers", () => {
		const text = EXAMPLE.replace(/^(defaults:\n)/m, "$1  monitor_report_email: true\n");
		const tagged = parseManifest(text);
		const hubRoot = Object.keys(tagged.spokes).find((n) => tagged.spokes[n]?.hosts_hub === true);
		if (!hubRoot) throw new Error("the example manifest has no hosts_hub spoke");
		const hub = renderRoot(tagged, hubRoot)["main.tf"];
		expect(hub).toContain('name = "pi-coms-monitor-reports"');
	});

	// SIO-1821 follow-up (Greptile P1, verified): renderTfvars REGENERATES the
	// file and preserves only coms_auth_token, so a hand-appended line is
	// silently deleted by the next render -- and `just fleet deploy` renders
	// before it applies. The ARN therefore has to come from the manifest.
	test("the report topic arn is rendered into tfvars, not hand-added", () => {
		const text = withHubArn(EXAMPLE);
		const tagged = parseManifest(text);
		for (const name of Object.keys(tagged.spokes)) {
			const spoke = tagged.spokes[name];
			if (!spoke) continue;
			const tfvars = renderRoot(tagged, name)["terraform.tfvars"];
			const boundToPrdHub = spoke.hub === "eu-shared-services-prd";
			if (spoke.hosts_hub || !boundToPrdHub) {
				// The hub root gets it by Terraform reference; a spoke on ANOTHER hub
				// must never see this hub's ARN -- environments never cross. It may
				// carry the placeholder, which is the "enabled but not yet applied"
				// state and is what the next test covers.
				expect({ name, leaked: tfvars.includes(PRD_ARN) }).toEqual({ name, leaked: false });
			} else {
				expect(tfvars).toContain(`monitor_report_sns_topic_arn = "${PRD_ARN}"`);
			}
		}
	});

	// The bug this shape prevents: a fleet-wide default rendered the PRD topic
	// into every dev spoke, so dev digests would have mailed the prd channel.
	test("a spoke on another hub never gets this hub's topic", () => {
		const tagged = parseManifest(withHubArn(EXAMPLE));
		const devSpoke = Object.keys(tagged.spokes).find(
			(n) => !tagged.spokes[n]?.hosts_hub && tagged.spokes[n]?.hub !== "eu-shared-services-prd",
		);
		if (!devSpoke) throw new Error("the example manifest has no non-hub spoke on another hub");
		expect(renderRoot(tagged, devSpoke)["terraform.tfvars"]).not.toContain(PRD_ARN);
	});

	test("re-rendering keeps the topic arn (the hand-edit failure mode)", () => {
		const text = withHubArn(EXAMPLE);
		const tagged = parseManifest(text);
		const spoke = Object.keys(tagged.spokes).find(
			(n) => !tagged.spokes[n]?.hosts_hub && tagged.spokes[n]?.hub === "eu-shared-services-prd",
		);
		if (!spoke) throw new Error("no non-hub prd spoke in the example manifest");
		const first = renderRoot(tagged, spoke)["terraform.tfvars"];
		const second = renderTfvars(tagged, spoke, first);
		expect(second).toContain("monitor_report_sns_topic_arn");
		// And the minted token still survives, as before.
		const withToken = first.replace(/coms_auth_token = "[^"]*"/, 'coms_auth_token = "MINTED"');
		expect(renderTfvars(tagged, spoke, withToken)).toContain('coms_auth_token = "MINTED"');
	});

	// SIO-1821 follow-up (Greptile P1, verified): enabling the feature without
	// the hub arn parsed happily, created the topic, and left every spoke with an
	// empty env var -- reporting silently off. The ARN genuinely does not exist
	// until the hub root is applied once, so this cannot be a hard error; it
	// renders the same visible placeholder org_id uses, which shows up in the
	// tfvars and fails loudly at apply rather than shipping a dead feature.
	test("monitor_report_email without a hub arn renders a visible placeholder", () => {
		// Empty on the hub = "this hub wants email, topic not applied yet".
		const text = EXAMPLE.replace(/^(defaults:\n)/m, "$1  monitor_report_email: true\n").replace(
			/^( {2}eu-shared-services-prd:\n)/m,
			'$1    monitor_report_sns_topic_arn: ""\n',
		);
		const tagged = parseManifest(text);
		const spoke = Object.keys(tagged.spokes).find(
			(n) => !tagged.spokes[n]?.hosts_hub && tagged.spokes[n]?.hub === "eu-shared-services-prd",
		);
		if (!spoke) throw new Error("no non-hub prd spoke in the example manifest");
		const tfvars = renderRoot(tagged, spoke)["terraform.tfvars"];
		expect(tfvars).toContain("<set:");

		// And a hub that never asked for email leaves its spokes alone, rather
		// than blocking their plan for a feature that environment does not use.
		const devSpoke = Object.keys(tagged.spokes).find(
			(n) => !tagged.spokes[n]?.hosts_hub && tagged.spokes[n]?.hub !== "eu-shared-services-prd",
		);
		if (!devSpoke) throw new Error("no non-hub spoke on another hub");
		expect(renderRoot(tagged, devSpoke)["terraform.tfvars"]).not.toContain("monitor_report_sns_topic_arn");
	});

	test("no monitor_report_email renders no tfvar line at all", () => {
		for (const name of Object.keys(manifest.spokes)) {
			expect(renderRoot(manifest, name)["terraform.tfvars"]).not.toContain("monitor_report_sns_topic_arn");
		}
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
