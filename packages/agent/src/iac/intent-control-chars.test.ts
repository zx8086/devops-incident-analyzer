// agent/src/iac/intent-control-chars.test.ts

import { describe, expect, test } from "bun:test";
import { parseIntentJson } from "./nodes.ts";

// SIO-1221: parseIntentJson has verbatim-copy fields (userSettingsYaml, phasesPatch,
// ilmFullPolicy, ingest-pipeline bodies), so a user-pasted multi-line document is echoed straight
// into a JSON string value. That is SIO-1219's failure shape, and here it did not crash -- it
// silently degraded a valid gitops request into a "which cluster?" re-ask, which is why it went
// unnoticed for the whole elastic-iac graph.

describe("parseIntentJson — unescaped control chars in verbatim-copy fields", () => {
	test("recovers a cluster-settings-edit whose userSettingsYaml carries raw newlines and a tab", () => {
		// userSettingsYaml is z.string(): a pasted YAML block lands here verbatim, and its
		// newlines are unescaped inside the JSON string literal.
		const raw =
			'{"workflow":"cluster-settings-edit","cluster":"eu-b2b","userSettingsYaml":"xpack:\n  security:\n\tenabled: true"}';
		expect(() => JSON.parse(raw)).toThrow();

		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("cluster-settings-edit");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.clarification).toBeUndefined();
	});

	test("recovers an ilm-rollout with a raw newline nested inside phasesPatch", () => {
		const raw =
			'{"workflow":"ilm-rollout","cluster":"eu-b2b","policyName":"metrics","phasesPatch":{"note":"line one\nline two"}}';
		expect(() => JSON.parse(raw)).toThrow();

		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("ilm-rollout");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.clarification).toBeUndefined();
	});

	// The pre-SIO-1221 outcome for the cases above, kept explicit: control characters
	// produced this silent re-ask rather than a visible error.
	test("genuinely malformed JSON still falls through to the safe clarify default", () => {
		const req = parseIntentJson('{"workflow":"ilm-rollout",,}');
		expect(req.workflow).toBe("other");
		expect(req.isProd).toBe(false);
		expect(req.clarification).toBe("Which cluster and what change should I make?");
	});

	// An unknown workflow name must still fall through -- the sanitizer must not widen the
	// enum by accident.
	test("an off-enum workflow name still falls through to the clarify default", () => {
		const req = parseIntentJson('{"workflow":"ilm-full-policy","cluster":"eu-b2b"}');
		expect(req.workflow).toBe("other");
	});
});
