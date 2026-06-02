// agent/src/iac/version-upgrade.test.ts
import { describe, expect, test } from "bun:test";
import { branchSlug, parseIntentJson } from "./nodes.ts";

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
