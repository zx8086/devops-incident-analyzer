// packages/agent/src/eval/evaluators.test.ts
//
// SIO-1372: the root-cause gate must be enforced in CODE, not just prompt steering -- the
// DEVOPS-1386 case proved an instructed judge can still score a wrong-cause response 8/10.
// These tests pin the cap, the schema's tolerant degradation, and the feedback mapping
// (including the not_determinable omission) without any OpenAI call.
import { describe, expect, test } from "bun:test";
import { applyRootCauseCap, HolisticGradeSchema, judgeFeedback } from "./evaluators.ts";

describe("applyRootCauseCap (SIO-1372)", () => {
	test("incorrect caps at 4 -- a wrong cause can never grade above weak", () => {
		expect(applyRootCauseCap(8, "incorrect")).toBe(4);
		expect(applyRootCauseCap(10, "incorrect")).toBe(4);
		expect(applyRootCauseCap(3, "incorrect")).toBe(3);
	});

	test("partial caps at 7 -- category-adjacent never reaches exceptional", () => {
		expect(applyRootCauseCap(8, "partial")).toBe(7);
		expect(applyRootCauseCap(10, "partial")).toBe(7);
		expect(applyRootCauseCap(3, "partial")).toBe(3);
	});

	test("correct and not_determinable pass through unchanged", () => {
		expect(applyRootCauseCap(8, "correct")).toBe(8);
		expect(applyRootCauseCap(2, "correct")).toBe(2);
		expect(applyRootCauseCap(9, "not_determinable")).toBe(9);
	});
});

describe("HolisticGradeSchema rootCauseMatch tolerance (SIO-1372)", () => {
	test("missing rootCauseMatch degrades to not_determinable, not a parse failure", () => {
		const grade = HolisticGradeSchema.parse({ score: 7, reasoning: "solid" });
		expect(grade.rootCauseMatch).toBe("not_determinable");
	});

	test("a bogus enum value degrades to not_determinable", () => {
		const grade = HolisticGradeSchema.parse({ score: 7, rootCauseMatch: "mostly right", reasoning: "x" });
		expect(grade.rootCauseMatch).toBe("not_determinable");
	});

	test("valid verdicts parse through untouched", () => {
		for (const v of ["correct", "partial", "incorrect", "not_determinable"] as const) {
			expect(HolisticGradeSchema.parse({ score: 5, rootCauseMatch: v, reasoning: "" }).rootCauseMatch).toBe(v);
		}
	});
});

describe("judgeFeedback (SIO-1372)", () => {
	test("incorrect: response_quality is capped at 4 and root_cause_accuracy is 0", () => {
		const fb = judgeFeedback({ score: 8, rootCauseMatch: "incorrect", reasoning: "wrong cause" });
		expect(fb).toHaveLength(2);
		const quality = fb.find((f) => f.key === "response_quality");
		expect(quality?.score).toBeCloseTo((4 - 1) / 9);
		expect(quality?.comment).toContain("capped from 8/10");
		const accuracy = fb.find((f) => f.key === "root_cause_accuracy");
		expect(accuracy?.score).toBe(0);
	});

	test("partial: capped at 7, accuracy 0.5", () => {
		const fb = judgeFeedback({ score: 9, rootCauseMatch: "partial", reasoning: "right category" });
		expect(fb.find((f) => f.key === "response_quality")?.score).toBeCloseTo((7 - 1) / 9);
		expect(fb.find((f) => f.key === "root_cause_accuracy")?.score).toBe(0.5);
	});

	test("correct: no cap note, accuracy 1", () => {
		const fb = judgeFeedback({ score: 9, rootCauseMatch: "correct", reasoning: "nailed it" });
		const quality = fb.find((f) => f.key === "response_quality");
		expect(quality?.score).toBeCloseTo((9 - 1) / 9);
		expect(quality?.comment).not.toContain("capped");
		expect(fb.find((f) => f.key === "root_cause_accuracy")?.score).toBe(1);
	});

	test("not_determinable emits ONLY response_quality -- synthetic examples must not pollute the accuracy average", () => {
		const fb = judgeFeedback({ score: 6, rootCauseMatch: "not_determinable", reasoning: "no reference" });
		expect(fb).toHaveLength(1);
		expect(fb[0]?.key).toBe("response_quality");
		expect(fb[0]?.score).toBeCloseTo((6 - 1) / 9);
	});
});
