// packages/agent/src/eval/spec-contradiction-judge.test.ts
// SIO-1440 check 1: RULES-vs-SOUL contradiction scan. Same split as evaluators.test.ts --
// unit-test the pure schema/prompt-building/feedback-shaping pieces; the live OpenAI call in
// judgeSpecContradictions is thin glue, deliberately left to a manual/opt-in probe (see SIO-1372
// precedent: responseQualityJudge's own openai.chat.completions.create call is untested too).
import { describe, expect, test } from "bun:test";
import {
	buildContradictionScanInput,
	ContradictionGradeSchema,
	contradictionJudgeFeedback,
	SPEC_CONTRADICTION_SYSTEM_PROMPT,
} from "./spec-contradiction-judge.ts";

describe("ContradictionGradeSchema", () => {
	test("parses a well-formed contradiction list", () => {
		const grade = ContradictionGradeSchema.parse({
			contradictions: [
				{
					soulClaim: "You may escalate directly to the on-call engineer.",
					rulesConstraint: "Never contact a human; act autonomously.",
					severity: "high",
				},
			],
		});
		expect(grade.contradictions).toHaveLength(1);
		expect(grade.contradictions[0]?.severity).toBe("high");
	});

	test("parses an empty contradiction list (the clean case)", () => {
		const grade = ContradictionGradeSchema.parse({ contradictions: [] });
		expect(grade.contradictions).toEqual([]);
	});

	test("tolerates a missing contradictions key by defaulting to empty (malformed JSON should not crash the scan)", () => {
		const grade = ContradictionGradeSchema.parse({});
		expect(grade.contradictions).toEqual([]);
	});

	test("tolerates an unknown severity by defaulting to low rather than rejecting the whole response", () => {
		const grade = ContradictionGradeSchema.parse({
			contradictions: [{ soulClaim: "a", rulesConstraint: "b", severity: "extreme" }],
		});
		expect(grade.contradictions[0]?.severity).toBe("low");
	});
});

describe("buildContradictionScanInput", () => {
	test("includes both SOUL and RULES content, labeled", () => {
		const input = buildContradictionScanInput("You are a helpful assistant.", "Never contact a human.");
		expect(input).toContain("You are a helpful assistant.");
		expect(input).toContain("Never contact a human.");
		expect(input).toContain("SOUL.md");
		expect(input).toContain("RULES.md");
	});
});

describe("contradictionJudgeFeedback", () => {
	test("zero contradictions yields a passing feedback record", () => {
		const feedback = contradictionJudgeFeedback({ ok: true, grade: { contradictions: [] } }, "elastic-agent");
		expect(feedback).toEqual([
			{ key: "spec_contradiction_elastic-agent", score: 1, comment: "no contradictions found" },
		]);
	});

	test("any contradiction yields a failing feedback record naming the worst severity", () => {
		const feedback = contradictionJudgeFeedback(
			{
				ok: true,
				grade: {
					contradictions: [
						{ soulClaim: "a", rulesConstraint: "b", severity: "low" },
						{ soulClaim: "c", rulesConstraint: "d", severity: "high" },
					],
				},
			},
			"elastic-agent",
		);
		expect(feedback).toHaveLength(1);
		expect(feedback[0]?.key).toBe("spec_contradiction_elastic-agent");
		expect(feedback[0]?.score).toBe(0);
		expect(feedback[0]?.comment).toContain("2 contradiction");
		expect(feedback[0]?.comment).toContain("high");
	});

	// CodeRabbit (PR #630): a failed judge call (network error, malformed JSON, invalid
	// schema) used to collapse to { contradictions: [] } and report score: 1 -- indistinguishable
	// from a genuine clean pass. The CLI would exit 0 having never actually run the check.
	test("a failed judge call yields neither a pass nor a fail score -- score is undefined, not 1", () => {
		const feedback = contradictionJudgeFeedback({ ok: false, reason: "OpenAI request failed" }, "elastic-agent");
		expect(feedback).toHaveLength(1);
		expect(feedback[0]?.key).toBe("spec_contradiction_elastic-agent");
		expect(feedback[0]?.score).toBeUndefined();
		expect(feedback[0]?.comment).toContain("OpenAI request failed");
	});
});

describe("SPEC_CONTRADICTION_SYSTEM_PROMPT content", () => {
	test("instructs the judge to distinguish genuine conflicts from complementary constraints", () => {
		expect(SPEC_CONTRADICTION_SYSTEM_PROMPT.toLowerCase()).toContain("contradiction");
		expect(SPEC_CONTRADICTION_SYSTEM_PROMPT).toContain("SOUL.md");
		expect(SPEC_CONTRADICTION_SYSTEM_PROMPT).toContain("RULES.md");
	});
});
