// agent/src/iac/workflow-enum-sync.test.ts
// SIO-1003: the parseIntent instruction enum (the workflow values the planner is told it may emit) must
// stay in sync with the zod IntentSchema (the values the parser accepts). They previously drifted --
// cluster-settings-edit was in the schema but missing from the instruction prose, so the LLM could not
// select the shipped workflow. Both are now derived from WORKFLOW_VALUES; these tests pin that contract.
import { describe, expect, test } from "bun:test";
import { parseIntentJson, WORKFLOW_ENUM_PROSE } from "./nodes.ts";
import { WORKFLOW_VALUES } from "./state.ts";

describe("workflow enum sync (SIO-1003)", () => {
	test("parseIntentJson accepts EVERY workflow value the schema declares (no value is rejected to 'other')", () => {
		for (const workflow of WORKFLOW_VALUES) {
			const req = parseIntentJson(JSON.stringify({ workflow, cluster: "eu-b2b" }));
			expect(req.workflow).toBe(workflow);
		}
	});

	test("cluster-settings-edit specifically round-trips (the SIO-1003 regression)", () => {
		const req = parseIntentJson(
			JSON.stringify({
				workflow: "cluster-settings-edit",
				cluster: "eu-b2b",
				persistentPatch: { "xpack.monitoring.collection.interval": "60s" },
			}),
		);
		expect(req.workflow).toBe("cluster-settings-edit");
		expect(req.persistentPatch).toEqual({ "xpack.monitoring.collection.interval": "60s" });
	});

	test("WORKFLOW_VALUES has no duplicates and includes the workflows added recently", () => {
		expect(new Set(WORKFLOW_VALUES).size).toBe(WORKFLOW_VALUES.length);
		// Widen to string[] so the membership check accepts arbitrary string literals (toContain on the
		// narrow readonly IacWorkflow[] would reject a plain string at compile time).
		const values: readonly string[] = WORKFLOW_VALUES;
		for (const w of ["cluster-settings-edit", "index-template-create", "cluster-default-edit"]) {
			expect(values).toContain(w);
		}
	});

	test("the planner instruction enum prose lists EVERY workflow value (the prompt can't drift from the schema)", () => {
		// WORKFLOW_ENUM_PROSE is the exact "'a'|'b'|..." fragment embedded in the parseIntent instruction.
		for (const workflow of WORKFLOW_VALUES) {
			expect(WORKFLOW_ENUM_PROSE).toContain(`'${workflow}'`);
		}
		// And nothing extra: token count matches the value count.
		expect(WORKFLOW_ENUM_PROSE.split("|").length).toBe(WORKFLOW_VALUES.length);
	});
});
