// packages/agent/src/eval/evaluators.ts
import type { Example, Run } from "langsmith/schemas";
import OpenAI from "openai";
import { z } from "zod";
import { parseLlmJson } from "../llm-json.ts";

// Tolerant by design: the judge's own shape drifting must score an example 0, not
// abort the run.
//
// SIO-1372: replaces an earlier binary meets_rubric schema. A single boolean over an
// entire rubric flattens real quality differences to 0/1 -- verified this cycle by reading
// two model configs' actual response text for the same incident side by side: one response
// was visibly more thorough (per-node fatal-query timestamps, a live index-advisor DDL
// recommendation) than the other, yet both scored the same because each missed exactly one
// of five rubric clauses. A 1-10 holistic score against the real ticket's own report, not a
// clause checklist, can express that gradient.
export const HolisticGradeSchema = z.object({
	score: z
		.number()
		.nullish()
		.transform((v) => (v === null || v === undefined ? 1 : Math.min(10, Math.max(1, Math.round(v))))),
	// SIO-1372: the root-cause gate. The judge must answer this BEFORE scoring; a missing or
	// mangled value degrades to not_determinable (no cap, no accuracy feedback) rather than
	// failing the example -- same tolerance philosophy as the other fields.
	rootCauseMatch: z.enum(["correct", "partial", "incorrect", "not_determinable"]).catch("not_determinable"),
	reasoning: z
		.union([z.string(), z.number(), z.null()])
		.optional()
		.transform((v) => (v === null || v === undefined ? "" : String(v))),
});

export type RootCauseMatch = z.output<typeof HolisticGradeSchema>["rootCauseMatch"];
export type HolisticGrade = z.output<typeof HolisticGradeSchema>;

// SIO-1372: the code-level gate. DEVOPS-1386 proved a prompt instruction alone does not hold:
// the judge scored a response 8/10 ("solid") despite its own band text placing a missed root
// cause at 3-4 -- confident, well-organized prose pulled the holistic score past the band. The
// cap makes the bands binding: a wrong cause can never grade above weak (4), a category-adjacent
// one never above the solid floor (7).
export function applyRootCauseCap(score: number, match: RootCauseMatch): number {
	if (match === "incorrect") return Math.min(score, 4);
	if (match === "partial") return Math.min(score, 7);
	return score;
}

// SIO-1372 (CodeRabbit PR #590): the schema's .catch() must not become a cap bypass, so the
// verdict is squared against referenceReport availability BEFORE any scoring:
// - report-less example: force not_determinable no matter what the judge said, so a
//   hallucinated "correct" can never emit root_cause_accuracy=1 with nothing to have been
//   compared against.
// - report-backed example: not_determinable (which includes a missing or mangled field the
//   .catch() absorbed) is malformed judge output -- with the real report in the prompt the
//   judge can always rule correct/partial/incorrect. The caller scores the example 0 like any
//   other unusable judge response, rather than letting {"score": 10} skip both the cap and the
//   accuracy feedback.
export function squareVerdictWithReference(grade: HolisticGrade, hasReference: boolean): HolisticGrade | "malformed" {
	if (!hasReference) return { ...grade, rootCauseMatch: "not_determinable" };
	if (grade.rootCauseMatch === "not_determinable") return "malformed";
	return grade;
}

// Pure mapping from a parsed grade to LangSmith feedback entries, split out so the cap and the
// not_determinable omission are unit-testable without an OpenAI call. not_determinable emits NO
// root_cause_accuracy entry: the synthetic dataset.ts examples have no referenceReport to be
// right or wrong against, and a placeholder score would pollute the metric's average in the
// LangSmith Compare view.
export function judgeFeedback(grade: HolisticGrade): { key: string; score: number; comment: string }[] {
	const capped = applyRootCauseCap(grade.score, grade.rootCauseMatch);
	const capNote = capped < grade.score ? ` (capped from ${grade.score}/10: root cause ${grade.rootCauseMatch})` : "";
	const quality = {
		key: "response_quality",
		// SIO-1372: score is 1-10 from the judge; LangSmith feedback scores are conventionally
		// 0-1, so normalize here rather than changing every downstream consumer's expectation.
		score: (capped - 1) / 9,
		comment: `${capped}/10${capNote} -- rootCauseMatch=${grade.rootCauseMatch} -- ${grade.reasoning}`,
	};
	if (grade.rootCauseMatch === "not_determinable") return [quality];
	return [
		quality,
		{
			key: "root_cause_accuracy",
			score: grade.rootCauseMatch === "correct" ? 1 : grade.rootCauseMatch === "partial" ? 0.5 : 0,
			comment: `rootCauseMatch=${grade.rootCauseMatch} -- ${grade.reasoning}`,
		},
	];
}

export function datasourcesCovered(run: Run, example: Example) {
	const expectedRaw = (example.outputs?.expectedDatasources ?? []) as unknown;
	const actualRaw =
		(run.outputs as { output?: { targetDataSources?: unknown } } | undefined)?.output?.targetDataSources ?? [];
	const expected = new Set<string>(Array.isArray(expectedRaw) ? (expectedRaw as string[]) : []);
	const actual = new Set<string>(Array.isArray(actualRaw) ? (actualRaw as string[]) : []);
	const missing = [...expected].filter((d) => !actual.has(d));
	return {
		key: "datasources_covered",
		score: missing.length === 0 ? 1 : 0,
		comment:
			missing.length === 0 ? `All ${expected.size} expected datasources covered` : `Missing: ${missing.join(", ")}`,
	};
}

export function confidenceThreshold(run: Run, example: Example) {
	const cap = (run.outputs as { output?: { confidenceCap?: number } } | undefined)?.output?.confidenceCap;
	const min = ((example.outputs?.minConfidence as number | undefined) ?? 0.6) as number;
	const ok = cap === undefined || cap >= min;
	return {
		key: "confidence_threshold",
		score: ok ? 1 : 0,
		comment: cap === undefined ? "No confidence cap set (rules satisfied)" : `Confidence capped at ${cap} (min ${min})`,
	};
}

// SIO-692: judge sees `run.outputs.output.response` only -- not tool-call trajectory.
// Rubrics/reports in dataset.ts must grade response content, not trajectory facts the
// judge can't observe.
//
// SIO-1372: rewritten from a binary meets_rubric checklist to a holistic 1-10 score
// compared against the real ticket's own investigation report (referenceReport), when one
// is available. The qualityRubric text is still passed as supporting context (it names the
// specific technical details -- exception classes, service names, root causes -- a from-
// scratch judge has no way to know), but the judge is explicitly told NOT to grade it as a
// pass/fail checklist: a response that is substantively as good as the real report, even if
// it misses a minor rubric clause, should score high. This is deliberately not a return to
// the earlier binary meets_rubric shape -- that shape is what flattened two visibly
// different-quality responses (one materially more thorough than the other) to the same
// score this cycle.
const HOLISTIC_JUDGE_SYSTEM_PROMPT = [
	"You are an experienced incident-response reviewer grading an AI agent's investigation report against the real, human-curated investigation of the same incident.",
	"You will be given: the real incident's own report (written by a human analyst reviewing the actual production investigation), a rubric describing what a thorough answer for this specific incident should cover, and the AI agent's response to grade.",
	// SIO-1372: the root-cause verdict comes FIRST and is its own required output field. The
	// earlier prompt mentioned root-cause correctness only inside the 3-4 scoring band, as one
	// of several disjunctive conditions -- advisory, not a required check -- and the judge
	// scored a well-written wrong-cause response 8/10 (DEVOPS-1386). Making the verdict a
	// separate mandatory first step keeps holistic fluency from absorbing correctness.
	"FIRST, before scoring anything else, determine whether the AI response's stated root cause matches the real report's root cause: 'correct' means it names the same specific mechanism/cause the real report identified; 'partial' means it lands in the right general category (e.g. both agree the driver is automated/internal/bulk traffic) but never names the specific mechanism the real report identified; 'incorrect' means it names a different or contradictory cause, or commits to no cause at all where the real report identified one; 'not_determinable' means no real report was provided to compare against.",
	"A thorough, well-organized response whose named cause is wrong is still a wrong answer -- do not let fluency, formatting, or investigative breadth pull the verdict toward 'correct'.",
	"Only after fixing that verdict, grade holistically, not as a checklist: judge overall investigative quality, evidence quality (specific, concrete findings vs vague assertions), and appropriate honesty about gaps/limitations -- the same way you would compare two colleagues' incident write-ups.",
	"A response that reaches the same substantive conclusion as the real report, with strong supporting evidence, should score highly even if it misses a minor rubric clause or a small point the real report happened to also make.",
	"A response that is vague, reaches the wrong conclusion, fabricates unsupported specifics, or omits a major finding the real report considered central should score low.",
	"Score on a 1-10 scale: 9-10 exceptional (matches or exceeds the real report's rigor), 7-8 solid (correct conclusion, good evidence, minor gaps), 5-6 mediocre (partially correct or thin evidence), 3-4 weak (misses the real root cause or is mostly vague), 1-2 poor (wrong, fabricated, or substantively empty).",
	'Respond with JSON: {"rootCauseMatch": "correct" | "partial" | "incorrect" | "not_determinable", "score": number (1-10), "reasoning": string (2-4 sentences: first justify the rootCauseMatch verdict, then explain the score)}',
].join(" ");

// SIO-1372 (CodeRabbit PR #590): example.outputs is Zod-parsed rather than cast, because
// referenceReport presence is load-bearing below -- it decides whether a not_determinable
// verdict is legitimate (no report to compare against) or malformed judge output.
const ExampleOutputsSchema = z.object({
	qualityRubric: z.string().min(1),
	referenceReport: z.string().min(1).optional(),
});

export async function responseQualityJudge(run: Run, example: Example) {
	const parsedOutputs = ExampleOutputsSchema.safeParse(example.outputs ?? {});
	const response = (run.outputs as { output?: { response?: string } } | undefined)?.output?.response;
	if (!parsedOutputs.success || !response) {
		return { key: "response_quality", score: 0, comment: "missing rubric or response" };
	}
	const { qualityRubric: rubric, referenceReport } = parsedOutputs.data;
	const openai = new OpenAI();
	const userContent = referenceReport
		? `Real incident report (written by a human analyst, the ground truth for this incident):\n${referenceReport}\n\nRubric (what a thorough answer for this incident should cover):\n${rubric}\n\nAI agent's response to grade:\n${response}\n\nScore the AI agent's response 1-10 by comparing it holistically to the real report and rubric above.`
		: `Rubric (what a thorough answer for this incident should cover -- no real incident report is available for this synthetic example, grade against the rubric alone):\n${rubric}\n\nResponse to grade:\n${response}\n\nScore the response 1-10 against the rubric.`;
	const r = await openai.chat.completions.create({
		model: "gpt-4o-mini",
		temperature: 0,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: HOLISTIC_JUDGE_SYSTEM_PROMPT },
			{ role: "user", content: userContent },
		],
	});
	// SIO-1221: this was the only unwrapped JSON.parse of model output in the repo -- the
	// `??` default only covered a null content, not malformed JSON, so a single bad judge
	// response threw and killed the whole eval run rather than scoring that example 0.
	const grade = parseLlmJson(r.choices[0]?.message?.content ?? "", HolisticGradeSchema);
	if (!grade.ok) {
		return {
			key: "response_quality",
			score: 0,
			comment: `judge response unusable (${grade.reason}): ${grade.message}`,
		};
	}
	const data = squareVerdictWithReference(grade.data, Boolean(referenceReport));
	if (data === "malformed") {
		return {
			key: "response_quality",
			score: 0,
			comment: "judge response unusable: rootCauseMatch missing or invalid for a report-backed example",
		};
	}
	// SIO-1372 (handover risk table + CodeRabbit PR #590): LLM judges are not perfectly
	// self-consistent -- warn on ANY score the cap actually changed (an incorrect 5-7 or a
	// partial 8+ was capped silently before) and on a correct verdict scored in the failing
	// band. Drift stays visible in the run log; never a hard failure that aborts the eval.
	const capped = applyRootCauseCap(data.score, data.rootCauseMatch);
	if (capped !== data.score || (data.rootCauseMatch === "correct" && data.score < 5)) {
		console.warn(
			`response_quality judge: rootCauseMatch=${data.rootCauseMatch} raw=${data.score} capped=${capped} -- ${data.reasoning}`,
		);
	}
	// One OpenAI call, two feedback entries (langsmith's RunEvaluatorLike accepts
	// EvaluationResult[]): response_quality carries the capped holistic score,
	// root_cause_accuracy makes the gate filterable on its own in the Compare UI.
	return judgeFeedback(data);
}
