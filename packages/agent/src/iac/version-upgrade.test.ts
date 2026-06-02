// agent/src/iac/version-upgrade.test.ts
import { describe, expect, test } from "bun:test";
import { branchSlug, deploymentJsonPath, parseIntentJson, setDeploymentVersion } from "./nodes.ts";

// SIO-871: an upgrade request with both cluster and target version must parse to a
// version-upgrade workflow with NO clarification, so it flows straight to the HITL
// plan-review gate instead of asking a redundant question.
describe("parseIntentJson — version-upgrade", () => {
	test("extracts workflow/cluster/version and does not clarify", () => {
		const raw = JSON.stringify({ workflow: "version-upgrade", cluster: "ap-cld", version: "9.4.2" });
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("version-upgrade");
		expect(req.cluster).toBe("ap-cld");
		expect(req.version).toBe("9.4.2");
		expect(req.clarification).toBeUndefined();
	});

	test("keeps a clarification when the planner emits one (e.g. no concrete version)", () => {
		const raw = JSON.stringify({
			workflow: "version-upgrade",
			cluster: "ap-cld",
			clarification: "Which target version should I upgrade ap-cld to?",
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("version-upgrade");
		expect(req.clarification).toContain("target version");
	});

	test("malformed output falls back to the safe clarify default", () => {
		const req = parseIntentJson("not json at all");
		expect(req.workflow).toBe("other");
		expect(req.clarification).toBeDefined();
	});

	// Regression: the planner emits explicit null for absent optional fields (and often
	// wraps the object in a ```json fence). Both must parse, not hit the clarify fallback.
	test("tolerates explicit nulls and a json code fence", () => {
		const raw =
			'```json\n{"workflow":"version-upgrade","cluster":"ap-cld","tier":null,"newSizeGb":null,"version":"9.4.2","reason":null,"isProd":true,"clarification":null}\n```';
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("version-upgrade");
		expect(req.cluster).toBe("ap-cld");
		expect(req.version).toBe("9.4.2");
		expect(req.tier).toBeUndefined();
		expect(req.clarification).toBeUndefined();
	});
});

describe("branchSlug", () => {
	test("uses the target version as the descriptor for an upgrade", () => {
		expect(branchSlug({ workflow: "version-upgrade", cluster: "ap-cld", version: "9.4.2", isProd: false })).toBe(
			"ap-cld-9-4-2-version-upgrade",
		);
	});

	test("uses tier/resource for a tier-resize", () => {
		expect(branchSlug({ workflow: "tier-resize", cluster: "eu-b2b", tier: "warm", isProd: false })).toBe(
			"eu-b2b-warm-tier-resize",
		);
	});
});

// SIO-873: the GitOps proposer edits the deployment JSON .version (full file content,
// not a diff) and commits via the GitLab API. setDeploymentVersion is the read-modify-write.
describe("setDeploymentVersion", () => {
	test("sets .version, returns the previous, preserves other fields", () => {
		const input = JSON.stringify({ name: "ap-cld", version: "9.4.1", region: "ap-east-1" }, null, 2);
		const out = setDeploymentVersion(input, "9.4.2");
		expect(out.previous).toBe("9.4.1");
		const parsed = JSON.parse(out.content);
		expect(parsed.version).toBe("9.4.2");
		expect(parsed.name).toBe("ap-cld");
		expect(parsed.region).toBe("ap-east-1");
	});

	test("re-serializes with 2-space indent and a trailing newline", () => {
		const out = setDeploymentVersion('{"version":"9.4.0"}', "9.4.2");
		expect(out.content.endsWith("}\n")).toBe(true);
		expect(out.content).toContain('  "version": "9.4.2"');
	});

	test("previous is undefined when the field was absent", () => {
		const out = setDeploymentVersion('{"name":"x"}', "9.4.2");
		expect(out.previous).toBeUndefined();
		expect(JSON.parse(out.content).version).toBe("9.4.2");
	});

	test("throws on non-object / invalid JSON", () => {
		expect(() => setDeploymentVersion("not json", "9.4.2")).toThrow();
		expect(() => setDeploymentVersion("[1,2,3]", "9.4.2")).toThrow("not an object");
	});
});

describe("deploymentJsonPath", () => {
	test("substitutes the literal ${cluster} placeholder", () => {
		expect(deploymentJsonPath("environments/_deployments/${cluster}.json", "ap-cld")).toBe(
			"environments/_deployments/ap-cld.json",
		);
	});

	test("substitutes every occurrence", () => {
		expect(deploymentJsonPath("${cluster}/x/${cluster}.json", "eu-b2b")).toBe("eu-b2b/x/eu-b2b.json");
	});
});
