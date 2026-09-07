// packages/agent/src/iac/mr-labels.test.ts
// SIO-1656 (DEFECT 2026-09-07-01): the AGENTS.md section 10 MR label contract.
// The defect was an MR opened with only [agent-generated, iac] -- no change
// class -- which check-mr-labels rejects. Pure module, no mocks needed.
import { describe, expect, test } from "bun:test";
import {
	CHANGE_CLASSES,
	type ChangeClass,
	changeClassForWorkflow,
	mrLabels,
	WORKFLOW_CHANGE_CLASS,
} from "./mr-labels.ts";
import { WORKFLOW_VALUES } from "./state.ts";

const isChangeClass = (v: string): v is ChangeClass => (CHANGE_CLASSES as readonly string[]).includes(v);

describe("SIO-1656 change-class mapping", () => {
	// The Record type already enforces this at compile time; asserted at runtime
	// so the failure names the missing workflow rather than a type error 200
	// lines away in nodes.ts.
	test("every workflow maps to a class the CI gate accepts", () => {
		for (const workflow of WORKFLOW_VALUES) {
			const cls = WORKFLOW_CHANGE_CLASS[workflow];
			expect(isChangeClass(cls)).toBe(true);
		}
		expect(Object.keys(WORKFLOW_CHANGE_CLASS).sort()).toEqual([...WORKFLOW_VALUES].sort());
	});

	test("the reported defect case maps to config-change", () => {
		// MR !630: a .version bump under environments/_deployments/.
		expect(WORKFLOW_CHANGE_CLASS["version-upgrade"]).toBe("config-change");
	});

	test("the acceptance-test classes map as the contract specifies", () => {
		expect(WORKFLOW_CHANGE_CLASS["ilm-rollout"]).toBe("ilm");
		expect(WORKFLOW_CHANGE_CLASS["ilm-delete"]).toBe("ilm");
		expect(WORKFLOW_CHANGE_CLASS["fleet-integration"]).toBe("fleet-integrations");
	});

	// Renovate owns dependency bumps; an agent MR claiming that class would
	// misattribute the change.
	test("no workflow claims the Renovate-owned dependencies class", () => {
		expect(Object.values(WORKFLOW_CHANGE_CLASS)).not.toContain("dependencies");
	});

	// Retired labels the gate rejects outright.
	test("no workflow maps to a retired label", () => {
		const retired = ["docs", "drift-detection", "drift-check", "bugfix"];
		for (const cls of Object.values(WORKFLOW_CHANGE_CLASS)) expect(retired).not.toContain(cls);
	});
});

describe("SIO-1656 mrLabels", () => {
	test("carries agent-generated + iac + exactly one change class", () => {
		for (const cls of CHANGE_CLASSES) {
			const labels = mrLabels(cls);
			expect(labels).toContain("agent-generated");
			// Exactly one class -- the gate rejects both zero and two.
			expect(labels.filter((l) => isChangeClass(l))).toEqual([cls]);
		}
	});

	test("a documentation MR carries no iac label", () => {
		expect(mrLabels("documentation")).toEqual(["agent-generated", "documentation"]);
	});

	test("every other class keeps the iac label", () => {
		for (const cls of CHANGE_CLASSES.filter((c) => c !== "documentation")) {
			expect(mrLabels(cls)).toContain("iac");
		}
	});

	// The regression guard: this exact set is what failed the gate on MR !630.
	test("never emits the bare agent-generated + iac pair", () => {
		for (const cls of CHANGE_CLASSES) {
			expect(mrLabels(cls)).not.toEqual(["agent-generated", "iac"]);
		}
	});
});

describe("SIO-1656 changeClassForWorkflow", () => {
	test("resolves a known workflow", () => {
		expect(changeClassForWorkflow("ilm-rollout")).toBe("ilm");
	});

	// iacRequest is IacRequest | null, so openMr can reach the create call with
	// no workflow. It must still send a class -- a wrong class is a relabel, a
	// missing one blocks the MR.
	test("falls back to a real class when the workflow is unknown", () => {
		expect(changeClassForWorkflow(undefined)).toBe("config-change");
		expect(isChangeClass(changeClassForWorkflow(undefined))).toBe(true);
	});
});
