// tests/fleet-manifest.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { externalIdFor, hubFor, parseManifest, spokeNames } from "../scripts/fleet/manifest.ts";

const EXAMPLE = readFileSync(path.join(import.meta.dir, "..", "deploy", "fleet.example.yaml"), "utf-8");

describe("fleet manifest (SIO-1653)", () => {
	test("the committed example parses and binds every spoke to its environment's hub", () => {
		const m = parseManifest(EXAMPLE);
		expect(Object.keys(m.hubs).sort()).toEqual(["dev", "prd"]);
		expect(spokeNames(m, [])).toHaveLength(9);
		expect(spokeNames(m, []).slice(0, 4)).toEqual([
			"eu-shared-services-dev",
			"eu-oit-dev",
			"eu-shared-services-prd",
			"eu-oit-prd",
		]);
		expect(hubFor(m, "prd").profile).toBe("eu-shared-services-prd");
		expect(externalIdFor(m, "eu-oit-prd")).toBe("devops-agent-prod-access");
		expect(externalIdFor(m, "eu-oit-dev")).toBe("devops-agent-dev-access");
	});

	test("a spoke whose env has no hub is refused", () => {
		const text = EXAMPLE.replace("hubs:\n  dev:", "hubs:\n  stg:").replace(/env: dev/g, "env: dev");
		expect(() => parseManifest(text)).toThrow('env "dev" has no hub');
	});

	test("a CIDR under two environments is refused (no cross-environment access)", () => {
		const text = EXAMPLE.replace("- 10.10.2.0/23       # prd oit VPC", "- 10.0.2.0/23        # copied from dev");
		expect(() => parseManifest(text)).toThrow("allow-listed on both the dev and prd hubs");
	});

	test("a spoke CIDR missing from its hub allow-list is refused", () => {
		const text = EXAMPLE.replace(
			"vpc_cidr: 10.0.2.0/23\n    readonly_role: create",
			"vpc_cidr: 10.0.4.0/23\n    readonly_role: create",
		);
		expect(() => parseManifest(text)).toThrow('spoke "eu-oit-dev": its VPC CIDR 10.0.4.0/23 is not in the dev hub');
	});

	test("a hub-hosting spoke must use the hub's profile", () => {
		const text = EXAMPLE.replace(
			"profile: eu-shared-services-prd\n    subnet_id: subnet-0prd0agent00000000",
			"profile: someone-else\n    subnet_id: subnet-0prd0agent00000000",
		);
		expect(() => parseManifest(text)).toThrow('spoke "eu-shared-services-prd" hosts the prd hub');
	});

	test("unknown spoke names are refused with the known list", () => {
		const m = parseManifest(EXAMPLE);
		expect(() => spokeNames(m, ["eu-nope-prd"])).toThrow('unknown spoke "eu-nope-prd"');
	});
});
