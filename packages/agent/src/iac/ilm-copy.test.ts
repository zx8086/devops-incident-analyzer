// agent/src/iac/ilm-copy.test.ts
// SIO-931: copy-from-reference. parseIntentJson lifts sourcePolicy; proposeIlmChange uses the
// source policy as the (correctly-shaped) base and merges overrides.
import { describe, expect, test } from "bun:test";
import { parseIntentJson } from "./nodes.ts";

describe("parseIntentJson sourcePolicy (SIO-931)", () => {
	test("lifts sourcePolicy + policyName from a copy request", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "ilm-rollout",
				cluster: "us-cld",
				policyName: "logs@lifecycle",
				sourcePolicy: "us-default-lifecycle-logs-prod",
			}),
		);
		expect(req.workflow).toBe("ilm-rollout");
		expect(req.policyName).toBe("logs@lifecycle");
		expect(req.sourcePolicy).toBe("us-default-lifecycle-logs-prod");
	});

	test("sourcePolicy is undefined for a plain change", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "ilm-rollout",
				cluster: "us-cld",
				policyName: "logs",
				phasesPatch: { delete: { min_age: "60d" } },
			}),
		);
		expect(req.sourcePolicy).toBeUndefined();
	});
});
