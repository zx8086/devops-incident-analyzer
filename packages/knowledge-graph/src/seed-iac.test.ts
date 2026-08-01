// knowledge-graph/src/seed-iac.test.ts
import { describe, expect, test } from "bun:test";
import { DEPLOYMENT_INVENTORY, isDeploymentDir, parseModuleSources } from "./seed-iac.ts";

describe("parseModuleSources", () => {
	test("extracts a single module source", () => {
		const mainTf = `
module "deployment" {
  source = "../../modules/deployment"
}
`;
		expect(parseModuleSources(mainTf)).toEqual(["deployment"]);
	});

	test("extracts several modules wired by one stack (e.g. deployments = deployment + traffic-filter)", () => {
		const mainTf = `
module "deployment" {
  source = "../../modules/deployment"
}
module "traffic_filter" {
  source = "../../modules/traffic-filter"
}
`;
		expect(parseModuleSources(mainTf)).toEqual(["deployment", "traffic-filter"]);
	});

	test("dedupes a module sourced more than once", () => {
		const mainTf = `
module "a" { source = "../../modules/slo" }
module "b" { source = "../../modules/slo" }
`;
		expect(parseModuleSources(mainTf)).toEqual(["slo"]);
	});

	test("returns an empty array when main.tf wires no modules", () => {
		expect(parseModuleSources('resource "foo" "bar" {}')).toEqual([]);
	});

	test("ignores a source that isn't under modules/ (e.g. a registry module)", () => {
		const mainTf = `module "x" { source = "hashicorp/consul/aws" }`;
		expect(parseModuleSources(mainTf)).toEqual([]);
	});
});

describe("isDeploymentDir", () => {
	test("accepts a real deployment directory name", () => {
		expect(isDeploymentDir("eu-b2b")).toBe(true);
	});

	test("rejects underscore-prefixed config buckets (_deployments, _shared)", () => {
		expect(isDeploymentDir("_deployments")).toBe(false);
		expect(isDeploymentDir("_shared")).toBe(false);
	});
});

describe("DEPLOYMENT_INVENTORY", () => {
	test("every entry has both an ecId and a region", () => {
		for (const [name, entry] of Object.entries(DEPLOYMENT_INVENTORY)) {
			expect(entry.ecId, `${name} missing ecId`).toBeTruthy();
			expect(entry.region, `${name} missing region`).toBeTruthy();
		}
	});
});
