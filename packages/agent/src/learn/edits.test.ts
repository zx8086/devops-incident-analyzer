// agent/src/learn/edits.test.ts
import { describe, expect, test } from "bun:test";
import type { LearningProposal } from "@devops-agent/shared";
import { applyEdits } from "./edits.ts";

function proposal(): LearningProposal {
	return {
		ticketKey: "DEVOPS-1355",
		rootCause: {
			id: "rc-1",
			kind: "root-cause",
			causeClass: "route53-resolver-rule-missing",
			description: "original description",
			resolution: "original resolution",
			invalidatedHypotheses: [],
			evidence: ["quote"],
		},
		bindings: [
			{
				id: "bind-1",
				kind: "binding",
				action: "confirm",
				service: "svc",
				datasource: "kafka",
				bindingKind: "topic",
				resourceId: "orders.events",
				reason: "original reason",
				evidence: ["orders.events"],
			},
		],
		heuristics: [],
		memoryFacts: [{ id: "fact-1", kind: "memory-fact", text: "original text", evidence: ["quote"] }],
	};
}

describe("SIO-1128 applyEdits", () => {
	test("returns the proposal unchanged for an empty edits map (identity)", () => {
		const p = proposal();
		expect(applyEdits(p, {})).toEqual(p);
	});

	test("overrides a whitelisted prose field (memoryFact.text)", () => {
		const out = applyEdits(proposal(), { "fact-1": { text: "edited text" } });
		expect(out.memoryFacts[0]?.text).toBe("edited text");
	});

	test("overrides rootCause description + resolution", () => {
		const out = applyEdits(proposal(), { "rc-1": { description: "edited desc", resolution: "edited res" } });
		expect(out.rootCause?.description).toBe("edited desc");
		expect(out.rootCause?.resolution).toBe("edited res");
	});

	test("ignores a NON-whitelisted field (resourceId stays the distiller value)", () => {
		const out = applyEdits(proposal(), { "bind-1": { resourceId: "lkc-injected", reason: "edited reason" } });
		expect(out.bindings[0]?.resourceId).toBe("orders.events"); // untouched
		expect(out.bindings[0]?.reason).toBe("edited reason"); // whitelisted -> applied
	});

	test("falls back to the original on a blank/whitespace edit (never erases a field)", () => {
		const out = applyEdits(proposal(), { "fact-1": { text: "   " } });
		expect(out.memoryFacts[0]?.text).toBe("original text");
	});

	test("does not mutate the input proposal", () => {
		const p = proposal();
		applyEdits(p, { "fact-1": { text: "edited" } });
		expect(p.memoryFacts[0]?.text).toBe("original text");
	});
});
