import { describe, expect, test } from "bun:test";
import { applyStreamEvent, initialReducerState } from "./agent-reducer.ts";

describe("applyStreamEvent renovate_trigger_choice enrichment fields", () => {
	test("populates the enrichment fields when present", () => {
		const event = {
			type: "renovate_trigger_choice" as const,
			threadId: "t1",
			marker: "renovate/eu-onboarding-elastic_agent",
			line: "chore(deps): [eu-onboarding] elastic_agent to v2.9.4",
			message: "This will tick...",
			installedVersion: "2.8.0",
			targetVersion: "2.9.4",
			policyCount: 24,
			changelog: [{ version: "2.9.4", changes: [{ description: "Add X", type: "enhancement" }] }],
		};
		const result = applyStreamEvent(initialReducerState(), event);
		expect(result.renovateTriggerChoice?.installedVersion).toBe("2.8.0");
		expect(result.renovateTriggerChoice?.targetVersion).toBe("2.9.4");
		expect(result.renovateTriggerChoice?.policyCount).toBe(24);
		expect(result.renovateTriggerChoice?.changelog).toHaveLength(1);
	});

	test("tolerates missing enrichment fields (older/degraded payload)", () => {
		const event = {
			type: "renovate_trigger_choice" as const,
			threadId: "t1",
			marker: "x",
			line: "y",
			message: "z",
		};
		const result = applyStreamEvent(initialReducerState(), event);
		expect(result.renovateTriggerChoice?.installedVersion).toBeUndefined();
		expect(result.renovateTriggerChoice?.changelog).toBeUndefined();
	});
});
