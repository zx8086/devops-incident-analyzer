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
