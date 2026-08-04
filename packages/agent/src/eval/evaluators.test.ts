// packages/agent/src/eval/evaluators.test.ts
//
// SIO-1372: the root-cause gate must be enforced in CODE, not just prompt steering -- the
// DEVOPS-1386 case proved an instructed judge can still score a wrong-cause response 8/10.
// These tests pin the cap, the schema's tolerant degradation, and the feedback mapping
// (including the not_determinable omission) without any OpenAI call.
import { describe, expect, test } from "bun:test";
import {
	applyRootCauseCap,
	ExampleOutputsSchema,
	HOLISTIC_JUDGE_SYSTEM_PROMPT,
	HolisticGradeSchema,
	judgeFeedback,
	SubagentGradeSchema,
	squareVerdictWithReference,
	subagentJudgeFeedback,
	truncateForJudge,
} from "./evaluators.ts";

// CodeRabbit round 2 on PR #590: whitespace-only values must not pass min(1) -- a blank-ish
// referenceReport would otherwise silently select the report-backed grading path.
describe("ExampleOutputsSchema whitespace rejection (SIO-1372)", () => {
	test("whitespace-only qualityRubric fails the parse", () => {
		expect(ExampleOutputsSchema.safeParse({ qualityRubric: "   " }).success).toBe(false);
	});

	test("whitespace-only referenceReport fails the parse rather than grading report-backed", () => {
		expect(ExampleOutputsSchema.safeParse({ qualityRubric: "check X", referenceReport: "\n\t " }).success).toBe(false);
	});

	test("absent referenceReport stays optional", () => {
		const parsed = ExampleOutputsSchema.safeParse({ qualityRubric: "check X" });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.referenceReport).toBeUndefined();
	});
});

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

// CodeRabbit PR #590: the .catch("not_determinable") tolerance must not become a cap bypass.
describe("squareVerdictWithReference (SIO-1372)", () => {
	test("report-backed example with a missing/mangled verdict is malformed, not a free pass", () => {
		// A judge reply of {"score": 10} parses to not_determinable via .catch -- with a real
		// report present that must score the example 0, never an uncapped 10.
		const grade = HolisticGradeSchema.parse({ score: 10 });
		expect(squareVerdictWithReference(grade, true)).toBe("malformed");
	});

	test("report-backed example with a real verdict passes through untouched", () => {
		const grade = HolisticGradeSchema.parse({ score: 8, rootCauseMatch: "partial", reasoning: "x" });
		expect(squareVerdictWithReference(grade, true)).toEqual(grade);
	});

	test("report-less example is forced to not_determinable even when the judge says correct", () => {
		const grade = HolisticGradeSchema.parse({ score: 9, rootCauseMatch: "correct", reasoning: "hallucinated" });
		const squared = squareVerdictWithReference(grade, false);
		expect(squared).not.toBe("malformed");
		if (squared !== "malformed") {
			expect(squared.rootCauseMatch).toBe("not_determinable");
			// Downstream, that means NO root_cause_accuracy entry can be emitted.
			expect(judgeFeedback(squared)).toHaveLength(1);
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

describe("judgeFeedback datasourceVerdicts (SIO-1374)", () => {
	test("no datasourceVerdicts: no evidence_ keys emitted, existing keys unaffected", () => {
		const fb = judgeFeedback({ score: 8, rootCauseMatch: "correct", reasoning: "x" });
		expect(fb.some((f) => f.key.startsWith("evidence_"))).toBe(false);
		expect(fb).toHaveLength(2);
	});

	test("one evidence_<datasource> key per datasource in datasourceVerdicts", () => {
		const fb = judgeFeedback({
			score: 8,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: {
				elastic: { verdict: "found", gapsHonest: true, fabricated: false },
				kafka: { verdict: "missed", gapsHonest: true, fabricated: false },
			},
		});
		const elastic = fb.find((f) => f.key === "evidence_elastic");
		const kafka = fb.find((f) => f.key === "evidence_kafka");
		expect(elastic?.score).toBe(1);
		expect(kafka?.score).toBe(0);
	});

	test("partial verdict scores 0.5", () => {
		const fb = judgeFeedback({
			score: 8,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: { aws: { verdict: "partial", gapsHonest: false, fabricated: false } },
		});
		expect(fb.find((f) => f.key === "evidence_aws")?.score).toBe(0.5);
	});

	test("comment includes gapsHonest and fabricated flags", () => {
		const fb = judgeFeedback({
			score: 8,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: { aws: { verdict: "found", gapsHonest: false, fabricated: true } },
		});
		const aws = fb.find((f) => f.key === "evidence_aws");
		expect(aws?.comment).toContain("gapsHonest=false");
		expect(aws?.comment).toContain("fabricated=true");
	});

	// CodeRabbit (PR #591): judgeFeedback previously emitted an evidence_<datasource> key for
	// EVERY datasource the judge returned in datasourceVerdicts, with no check against the
	// example's actual referenceFindings. The prompt only ASKS the judge to populate
	// datasourceVerdicts when referenceFindings exists, but an LLM is not a reliable enforcer of
	// that -- it can hallucinate the field on a synthetic example with no ground truth, or return
	// an extra datasource name never listed in referenceFindings, either of which would emit an
	// ungrounded evidence_<datasource> score that pollutes LangSmith's per-datasource metrics.
	test("allowedDatasources filters out ungrounded datasource keys the judge returned anyway", () => {
		const fb = judgeFeedback(
			{
				score: 8,
				rootCauseMatch: "correct",
				reasoning: "x",
				datasourceVerdicts: {
					elastic: { verdict: "found", gapsHonest: true, fabricated: false },
					// aws was never in referenceFindings -- judge hallucinated a verdict for it anyway.
					aws: { verdict: "missed", gapsHonest: true, fabricated: false },
				},
			},
			["elastic"],
		);
		expect(fb.find((f) => f.key === "evidence_elastic")).toBeDefined();
		expect(fb.find((f) => f.key === "evidence_aws")).toBeUndefined();
	});

	test("allowedDatasources=[] (no referenceFindings) suppresses every evidence_ key", () => {
		const fb = judgeFeedback(
			{
				score: 8,
				rootCauseMatch: "correct",
				reasoning: "x",
				datasourceVerdicts: { elastic: { verdict: "found", gapsHonest: true, fabricated: false } },
			},
			[],
		);
		expect(fb.some((f) => f.key.startsWith("evidence_"))).toBe(false);
	});

	test("omitting allowedDatasources keeps the existing unfiltered behavior", () => {
		const fb = judgeFeedback({
			score: 8,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: { elastic: { verdict: "found", gapsHonest: true, fabricated: false } },
		});
		expect(fb.find((f) => f.key === "evidence_elastic")).toBeDefined();
	});
});

describe("HolisticGradeSchema datasourceVerdicts (SIO-1374)", () => {
	test("datasourceVerdicts is optional and can be omitted", () => {
		const grade = HolisticGradeSchema.parse({ score: 7, rootCauseMatch: "correct", reasoning: "x" });
		expect(grade.datasourceVerdicts).toBeUndefined();
	});

	test("a well-formed datasourceVerdicts map parses through untouched", () => {
		const grade = HolisticGradeSchema.parse({
			score: 7,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: {
				elastic: { verdict: "found", gapsHonest: true, fabricated: false },
				kafka: { verdict: "missed", gapsHonest: true, fabricated: false },
			},
		});
		expect(grade.datasourceVerdicts?.elastic).toEqual({ verdict: "found", gapsHonest: true, fabricated: false });
		expect(grade.datasourceVerdicts?.kafka?.verdict).toBe("missed");
	});

	test("a bogus verdict enum value in one datasource degrades that entry only, does not fail the whole map", () => {
		const grade = HolisticGradeSchema.parse({
			score: 7,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: {
				elastic: { verdict: "somewhat", gapsHonest: true, fabricated: false },
				kafka: { verdict: "found", gapsHonest: true, fabricated: false },
			},
		});
		expect(grade.datasourceVerdicts?.elastic?.verdict).toBe("missed");
		expect(grade.datasourceVerdicts?.kafka?.verdict).toBe("found");
	});

	test("missing gapsHonest/fabricated booleans degrade to false, not a parse failure", () => {
		const grade = HolisticGradeSchema.parse({
			score: 7,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: { elastic: { verdict: "found" } },
		});
		expect(grade.datasourceVerdicts?.elastic).toEqual({ verdict: "found", gapsHonest: false, fabricated: false });
	});

	// CodeRabbit (PR #591): a non-object value (null, a string, etc.) at one datasource key
	// currently fails the WHOLE datasourceVerdicts map -- z.record's inner .catch() only rescues
	// validation errors on an otherwise-well-typed object, not a wrong-TYPE value at that key. This
	// contradicts the file's own stated design (per-key degradation, see the comment above
	// DatasourceVerdictSchema's usage) and means one bad datasource entry from a drifting judge
	// silently fails response_quality for the ENTIRE example, not just that one evidence_ key.
	test("a null value at one datasource key degrades that entry only, does not fail the whole map", () => {
		const grade = HolisticGradeSchema.parse({
			score: 7,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: {
				elastic: null,
				kafka: { verdict: "found", gapsHonest: true, fabricated: false },
			},
		});
		expect(grade.datasourceVerdicts?.elastic).toEqual({ verdict: "missed", gapsHonest: false, fabricated: false });
		expect(grade.datasourceVerdicts?.kafka?.verdict).toBe("found");
	});

	test("a non-object (string) value at one datasource key degrades that entry only", () => {
		const grade = HolisticGradeSchema.parse({
			score: 7,
			rootCauseMatch: "correct",
			reasoning: "x",
			datasourceVerdicts: {
				aws: "not an object",
				gitlab: { verdict: "partial", gapsHonest: true, fabricated: false },
			},
		});
		expect(grade.datasourceVerdicts?.aws).toEqual({ verdict: "missed", gapsHonest: false, fabricated: false });
		expect(grade.datasourceVerdicts?.gitlab?.verdict).toBe("partial");
	});
});

describe("HOLISTIC_JUDGE_SYSTEM_PROMPT content (SIO-1374)", () => {
	test("instructs era-drift observations to be classified as outside-window, not fabrication", () => {
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT).toContain("outside the reference window");
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT.toLowerCase()).toContain("recurrence window");
	});

	test("instructs the judge to populate datasourceVerdicts with gapsHonest and fabricated flags", () => {
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT).toContain("datasourceVerdicts");
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT).toContain("gapsHonest");
		expect(HOLISTIC_JUDGE_SYSTEM_PROMPT).toContain("fabricated");
	});
});

describe("SubagentGradeSchema (SIO-1374)", () => {
	test("parses a well-formed per-datasource accuracy map", () => {
		const grade = SubagentGradeSchema.parse({
			datasourceAccuracy: {
				elastic: { accuracy: "correct", reasoning: "matched the deadlock chain" },
				kafka: { accuracy: "missing", reasoning: "no DLQ evidence surfaced" },
			},
		});
		expect(grade.datasourceAccuracy.elastic?.accuracy).toBe("correct");
		expect(grade.datasourceAccuracy.kafka?.accuracy).toBe("missing");
	});

	test("a bogus accuracy enum value degrades that entry to incorrect, not a parse failure", () => {
		const grade = SubagentGradeSchema.parse({
			datasourceAccuracy: { elastic: { accuracy: "sort of", reasoning: "x" } },
		});
		expect(grade.datasourceAccuracy.elastic?.accuracy).toBe("incorrect");
	});

	test("missing datasourceAccuracy degrades to an empty object, not a parse failure", () => {
		const grade = SubagentGradeSchema.parse({});
		expect(grade.datasourceAccuracy).toEqual({});
	});

	// CodeRabbit (PR #591): the outer .catch({}) on the whole datasourceAccuracy record rescues a
	// malformed record itself (e.g. not an object at all), but z.record still fails validation as
	// soon as ONE inner value is the wrong type -- and that failure propagates to the outer
	// .catch(), which discards the ENTIRE map, including every other well-formed entry. A single
	// malformed datasource from a drifting judge silently loses subagent_accuracy_* feedback for
	// every OTHER datasource in the same response, not just the bad one.
	test("a null value at one datasource key does not silently discard every other entry", () => {
		const grade = SubagentGradeSchema.parse({
			datasourceAccuracy: {
				elastic: null,
				kafka: { accuracy: "correct", reasoning: "matched the deadlock chain" },
			},
		});
		expect(grade.datasourceAccuracy.kafka?.accuracy).toBe("correct");
		expect(grade.datasourceAccuracy.elastic?.accuracy).toBe("incorrect");
	});
});

describe("subagentJudgeFeedback (SIO-1374)", () => {
	test("emits one subagent_accuracy_<datasource> key per graded datasource", () => {
		const fb = subagentJudgeFeedback({
			datasourceAccuracy: {
				elastic: { accuracy: "correct", reasoning: "matched" },
				kafka: { accuracy: "partial", reasoning: "half right" },
				aws: { accuracy: "missing", reasoning: "nothing surfaced" },
				gitlab: { accuracy: "incorrect", reasoning: "wrong conclusion" },
			},
		});
		expect(fb.find((f) => f.key === "subagent_accuracy_elastic")?.score).toBe(1);
		expect(fb.find((f) => f.key === "subagent_accuracy_kafka")?.score).toBe(0.5);
		expect(fb.find((f) => f.key === "subagent_accuracy_aws")?.score).toBe(0);
		expect(fb.find((f) => f.key === "subagent_accuracy_gitlab")?.score).toBe(0);
	});

	test("empty datasourceAccuracy emits no feedback entries", () => {
		expect(subagentJudgeFeedback({ datasourceAccuracy: {} })).toHaveLength(0);
	});

	// CodeRabbit (PR #591): the judge is only ever ASKED about referenceFindings' datasources, but
	// its JSON response is not guaranteed to respect that -- an extra hallucinated key would
	// otherwise emit an ungrounded subagent_accuracy_<datasource> score.
	test("allowedDatasources filters out a datasource the judge graded but was never asked about", () => {
		const fb = subagentJudgeFeedback(
			{
				datasourceAccuracy: {
					elastic: { accuracy: "correct", reasoning: "matched" },
					aws: { accuracy: "missing", reasoning: "nothing surfaced" },
				},
			},
			["elastic"],
		);
		expect(fb.find((f) => f.key === "subagent_accuracy_elastic")).toBeDefined();
		expect(fb.find((f) => f.key === "subagent_accuracy_aws")).toBeUndefined();
	});

	test("omitting allowedDatasources keeps the existing unfiltered behavior", () => {
		const fb = subagentJudgeFeedback({
			datasourceAccuracy: { elastic: { accuracy: "correct", reasoning: "matched" } },
		});
		expect(fb.find((f) => f.key === "subagent_accuracy_elastic")).toBeDefined();
	});
});

// CodeRabbit (PR #591): buildSubagentReports concatenates every deployment's serialized
// *Findings object for a datasource with no cap, so an example that fanned out across multiple
// deployments/estates could produce an oversized judgeSubagentReports prompt. This caps each
// datasource's report before it is interpolated into the judge's user message.
describe("truncateForJudge (SIO-1374 follow-up, PR #591)", () => {
	test("text at or under the cap passes through unchanged", () => {
		expect(truncateForJudge("short report", 100)).toBe("short report");
	});

	test("text over the cap is truncated with an explicit marker", () => {
		const long = "x".repeat(150);
		const result = truncateForJudge(long, 100);
		expect(result.length).toBeLessThan(long.length);
		expect(result).toContain("x".repeat(100));
		expect(result).toContain("[truncated");
	});

	test("the truncation marker states how many characters were cut", () => {
		const long = "x".repeat(150);
		const result = truncateForJudge(long, 100);
		expect(result).toContain("50 chars");
	});
});
