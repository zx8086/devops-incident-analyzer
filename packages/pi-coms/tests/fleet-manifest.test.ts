// tests/fleet-manifest.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { externalIdFor, hubFor, parseManifest, spokeNames } from "../scripts/fleet/manifest.ts";

const EXAMPLE = readFileSync(path.join(import.meta.dir, "..", "deploy", "fleet.example.yaml"), "utf-8");

describe("fleet manifest (SIO-1653)", () => {
	test("the committed example parses and binds every spoke to its named hub", () => {
		const m = parseManifest(EXAMPLE);
		// SIO-1666: hubs are keyed by selector (AWS profile), not environment.
		expect(Object.keys(m.hubs).sort()).toEqual(["eu-shared-services-dev", "eu-shared-services-prd"]);
		expect(spokeNames(m, [])).toHaveLength(9);
		expect(spokeNames(m, []).slice(0, 4)).toEqual([
			"eu-shared-services-dev",
			"eu-oit-dev",
			"eu-shared-services-prd",
			"eu-oit-prd",
		]);
		expect(hubFor(m, "eu-shared-services-prd").profile).toBe("eu-shared-services-prd");
		// account_id is the canonical identity, so it selects a hub too.
		expect(hubFor(m, "222222222222").environment).toBe("prd");
		// Every spoke names its hub explicitly rather than inheriting it from env.
		expect(m.spokes["eu-oit-prd"]?.hub).toBe("eu-shared-services-prd");
		expect(externalIdFor(m, "eu-oit-prd")).toBe("devops-agent-prod-access");
		expect(externalIdFor(m, "eu-oit-dev")).toBe("devops-agent-dev-access");
	});

	test("a spoke naming a hub that is not in the manifest is refused", () => {
		const text = EXAMPLE.replace("hub: eu-shared-services-dev", "hub: eu-nowhere-dev");
		expect(() => parseManifest(text)).toThrow('hub "eu-nowhere-dev" is not in the manifest');
	});

	// SIO-1666: the no-cross-environment rule used to be implied by the key. Now
	// that a hub carries its environment, it is checkable directly.
	test("a spoke bound to a hub of another environment is refused", () => {
		const text = EXAMPLE.replace(
			"    env: dev\n    hub: eu-shared-services-dev\n    profile: eu-oit-dev",
			"    env: dev\n    hub: eu-shared-services-prd\n    profile: eu-oit-dev",
		);
		expect(() => parseManifest(text)).toThrow("no cross-environment access");
	});

	// SIO-1666: the whole point of the rekey -- two hubs in one environment.
	test("two hubs may share an environment when each has its own port and CIDRs", () => {
		const text = EXAMPLE.replace(
			"  eu-shared-services-prd:\n    profile: eu-shared-services-prd",
			[
				"  eu-other-domain-prd:",
				"    profile: eu-other-domain-prd",
				"    region: eu-central-1",
				"    environment: prd",
				"    local_port: 8790",
				'    account_id: "333333333333"',
				"    url: http://10.20.0.10:8787",
				"    private_ip: 10.20.0.10",
				"    subnet_id: subnet-0oth0hub0000000000",
				"    dist_bucket: pi-coms-dist-333333333333",
				"    allowed_cidrs:",
				"      - 10.20.0.0/23",
				"    token_env: PI_COMS_NET_AUTH_TOKEN_OTHER_PRD",
				"  eu-shared-services-prd:",
				"    profile: eu-shared-services-prd",
			].join("\n"),
		);
		const m = parseManifest(text);
		expect(Object.keys(m.hubs)).toContain("eu-other-domain-prd");
		expect(hubFor(m, "eu-other-domain-prd").environment).toBe("prd");
		expect(hubFor(m, "eu-shared-services-prd").environment).toBe("prd");
	});

	// local_port used to be derived (+1 prd, +2 stg): two prd hubs would collide
	// and the second tunnel would silently bind nothing.
	test("two hubs sharing a local_port are refused", () => {
		const text = EXAMPLE.replace(
			"    environment: prd\n    local_port: 8788",
			"    environment: prd\n    local_port: 8787",
		);
		expect(() => parseManifest(text)).toThrow("local_port 8787");
	});

	test("a CIDR under two hubs is refused (a subnet has one hub)", () => {
		const text = EXAMPLE.replace("- 10.10.2.0/23       # prd oit VPC", "- 10.0.2.0/23        # copied from dev");
		expect(() => parseManifest(text)).toThrow(
			'allow-listed on both the "eu-shared-services-dev" and "eu-shared-services-prd" hubs',
		);
	});

	test("a spoke CIDR missing from its hub allow-list is refused", () => {
		const text = EXAMPLE.replace(
			"vpc_cidr: 10.0.2.0/23\n    readonly_role: create",
			"vpc_cidr: 10.0.4.0/23\n    readonly_role: create",
		);
		expect(() => parseManifest(text)).toThrow(
			'spoke "eu-oit-dev": its VPC CIDR 10.0.4.0/23 is not in hub "eu-shared-services-dev"',
		);
	});

	test("a hub-hosting spoke must use the hub's profile", () => {
		const text = EXAMPLE.replace(
			"profile: eu-shared-services-prd\n    subnet_id: subnet-0prd0agent00000000",
			"profile: someone-else\n    subnet_id: subnet-0prd0agent00000000",
		);
		expect(() => parseManifest(text)).toThrow('spoke "eu-shared-services-prd" hosts hub "eu-shared-services-prd"');
	});

	test("unknown spoke names are refused with the known list", () => {
		const m = parseManifest(EXAMPLE);
		expect(() => spokeNames(m, ["eu-nope-prd"])).toThrow('unknown spoke "eu-nope-prd"');
	});
});
