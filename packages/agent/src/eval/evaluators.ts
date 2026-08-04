// packages/agent/src/eval/evaluators.ts
import type { Example, Run } from "langsmith/schemas";
import OpenAI from "openai";
import { z } from "zod";
import { parseLlmJson } from "../llm-json.ts";

const DATASOURCE_VERDICT_DEFAULT = { verdict: "missed" as const, gapsHonest: false, fabricated: false };

export const DatasourceVerdictSchema = z.object({
	verdict: z.enum(["found", "partial", "missed"]).catch("missed"),
	// SIO-1374: folded in from the section-judging idea rather than a separate graded pass --
	// see the design doc's non-goal on section-by-section grading. Missing/malformed booleans
	// degrade to false (not honest / not fabricated) rather than failing the entry, same
	// tolerance philosophy as the rest of this schema.
	gapsHonest: z.boolean().catch(false),
	fabricated: z.boolean().catch(false),
});
export type DatasourceVerdict = z.output<typeof DatasourceVerdictSchema>;

// CodeRabbit (PR #591): the .catch() calls INSIDE DatasourceVerdictSchema only rescue a
// malformed FIELD once Zod has already confirmed the value at that key is an object -- a
// datasource value that is null, a string, or any other non-object type fails z.object()'s own
// type check before those field-level .catch()es ever run, and z.record's inner schema failing
// propagates up to fail the WHOLE map (see HolisticGradeSchema.datasourceVerdicts below), not
// just that one key. A single malformed datasource in the judge's own JSON drift would silently
// zero out response_quality for the entire example. Wrapping the whole per-value schema in
// .catch() degrades a non-object (or otherwise unparseable) value to the same safe default the
// field-level catches already use, so per-key degradation actually holds as documented.
const TolerantDatasourceVerdictSchema = DatasourceVerdictSchema.catch(DATASOURCE_VERDICT_DEFAULT);

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
	// SIO-1374: for each expected datasource, did the response surface the evidence the real
	// ticket's referenceFindings says that datasource showed? Optional -- a judge response for
	// an example with no referenceFindings, or one that omits this field entirely, must not fail
	// the example (same graceful-degradation contract as rootCauseMatch). A per-key .catch()
	// on DatasourceVerdictSchema means one malformed datasource entry degrades only that key.
	datasourceVerdicts: z.record(z.string(), TolerantDatasourceVerdictSchema).optional(),
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
	const feedback: { key: string; score: number; comment: string }[] = [quality];
	if (grade.rootCauseMatch !== "not_determinable") {
		feedback.push({
			key: "root_cause_accuracy",
			score: grade.rootCauseMatch === "correct" ? 1 : grade.rootCauseMatch === "partial" ? 0.5 : 0,
			comment: `rootCauseMatch=${grade.rootCauseMatch} -- ${grade.reasoning}`,
		});
	}
	// SIO-1374: one evidence_<datasource> key per datasource the judge scored, so LangSmith
	// Compare can filter per-datasource weaknesses across A/B legs (e.g. "haiku's gitlab
	// evidence is systematically weak") instead of only seeing one aggregate score.
	for (const [datasource, v] of Object.entries(grade.datasourceVerdicts ?? {})) {
		feedback.push({
			key: `evidence_${datasource}`,
			score: v.verdict === "found" ? 1 : v.verdict === "partial" ? 0.5 : 0,
			comment: `verdict=${v.verdict} gapsHonest=${v.gapsHonest} fabricated=${v.fabricated}`,
		});
	}
	return feedback;
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
export const HOLISTIC_JUDGE_SYSTEM_PROMPT = [
	"You are an experienced incident-response reviewer grading an AI agent's investigation report against the real, human-curated investigation of the same incident.",
	"You will be given: the real incident's own report (written by a human analyst reviewing the actual production investigation), a rubric describing what a thorough answer for this specific incident should cover, per-datasource ground-truth findings when available, and the AI agent's response to grade.",
	// SIO-1372: the root-cause verdict comes FIRST and is its own required output field. The
	// earlier prompt mentioned root-cause correctness only inside the 3-4 scoring band, as one
	// of several disjunctive conditions -- advisory, not a required check -- and the judge
	// scored a well-written wrong-cause response 8/10 (DEVOPS-1386). Making the verdict a
	// separate mandatory first step keeps holistic fluency from absorbing correctness.
	"FIRST, before scoring anything else, determine whether the AI response's stated root cause matches the real report's root cause: 'correct' means it names the same specific mechanism/cause the real report identified; 'partial' means it lands in the right general category (e.g. both agree the driver is automated/internal/bulk traffic) but never names the specific mechanism the real report identified; 'incorrect' means it names a different or contradictory cause, or commits to no cause at all where the real report identified one; 'not_determinable' means no real report was provided to compare against.",
	"A thorough, well-organized response whose named cause is wrong is still a wrong answer -- do not let fluency, formatting, or investigative breadth pull the verdict toward 'correct'.",
	// SIO-1374 (audit example #8, DEVOPS-1386): live replays investigate CURRENT systems, so the
	// AI response may truthfully describe a live recurrence window with additional co-occurring
	// symptoms that the reference report's frozen era does not mention. These are exempt from
	// fabrication classification if the response's own cited evidence genuinely supports them;
	// only assertions that contradict the reference report or invent specifics with no supporting
	// evidence count as fabrication. This grounding prevents live-recurrence observations from
	// falsely pulling the root-cause verdict toward 'incorrect'.
	"A response may describe a live recurrence window with additional co-occurring symptoms not present in the reference report's era -- if the response's own cited evidence genuinely supports those observations, classify them as 'outside the reference window', not as fabrication; only classify an observation as fabrication if it contradicts the reference report or invents specifics with no supporting evidence in the response itself. Continue judging the root-cause verdict on mechanism category and naming as usual.",
	"Only after fixing that verdict, grade holistically, not as a checklist: judge overall investigative quality, evidence quality (specific, concrete findings vs vague assertions), and appropriate honesty about gaps/limitations -- the same way you would compare two colleagues' incident write-ups.",
	"A response that reaches the same substantive conclusion as the real report, with strong supporting evidence, should score highly even if it misses a minor rubric clause or a small point the real report happened to also make.",
	"A response that is vague, reaches the wrong conclusion, fabricates unsupported specifics, or omits a major finding the real report considered central should score low.",
	"Score on a 1-10 scale: 9-10 exceptional (matches or exceeds the real report's rigor), 7-8 solid (correct conclusion, good evidence, minor gaps), 5-6 mediocre (partially correct or thin evidence), 3-4 weak (misses the real root cause or is mostly vague), 1-2 poor (wrong, fabricated, or substantively empty).",
	// SIO-1374: per-datasource verdicts, folded gaps-honesty and fabrication checks in as extra
	// fields per datasource (not a separate graded section -- see the design doc's non-goal on
	// section-by-section grading, which would re-measure pipeline-enforced formatting instead of
	// evidence quality).
	"If per-datasource ground-truth findings are provided, ALSO determine, for each datasource named in the ground truth: whether the response surfaced that datasource's specific evidence ('found'), surfaced some but missed the key specific detail ('partial'), or did not surface it at all ('missed'); whether the response was honest about gaps for that datasource (gapsHonest: true if it did not overclaim confidence where the ground truth shows a gap, or if there was no gap to admit; false if it overclaimed); and whether the response fabricated a specific finding for that datasource unsupported by the ground truth (fabricated: true/false). Do not penalize truthful recurrence-window observations (see above) as fabrication.",
	'Respond with JSON: {"rootCauseMatch": "correct" | "partial" | "incorrect" | "not_determinable", "score": number (1-10), "datasourceVerdicts": { "<datasource>": { "verdict": "found" | "partial" | "missed", "gapsHonest": boolean, "fabricated": boolean }, ... } (omit entirely if no per-datasource ground truth was provided), "reasoning": string (2-4 sentences: first justify the rootCauseMatch verdict, then explain the score, then briefly note any datasourceVerdicts of note)}',
].join(" ");

// SIO-1372 (CodeRabbit PR #590): example.outputs is Zod-parsed rather than cast, because
// referenceReport presence is load-bearing below -- it decides whether a not_determinable
// verdict is legitimate (no report to compare against) or malformed judge output.
// (CodeRabbit round 2: .trim() so a whitespace-only value cannot pass min(1) and select the
// report-backed grading path -- a blank-ish dataset field fails the parse loudly instead.)
export const ExampleOutputsSchema = z.object({
	qualityRubric: z.string().trim().min(1),
	referenceReport: z.string().trim().min(1).optional(),
	// SIO-1374: per-datasource ground truth passed to the judge alongside referenceReport, so it
	// can populate datasourceVerdicts against real per-datasource evidence rather than inferring
	// it from the Executive-Summary-only referenceReport text.
	referenceFindings: z.record(z.string(), z.string().trim().min(1)).optional(),
});

export async function responseQualityJudge(run: Run, example: Example) {
	const parsedOutputs = ExampleOutputsSchema.safeParse(example.outputs ?? {});
	const response = (run.outputs as { output?: { response?: string } } | undefined)?.output?.response;
	if (!parsedOutputs.success || !response) {
		return { key: "response_quality", score: 0, comment: "missing rubric or response" };
	}
	const { qualityRubric: rubric, referenceReport, referenceFindings } = parsedOutputs.data;
	const openai = new OpenAI();
	const findingsBlock = referenceFindings
		? `\n\nPer-datasource ground-truth findings (what the real investigation found from each source):\n${Object.entries(
				referenceFindings,
			)
				.map(([ds, text]) => `- ${ds}: ${text}`)
				.join("\n")}`
		: "";
	const userContent = referenceReport
		? `Real incident report (written by a human analyst, the ground truth for this incident):\n${referenceReport}${findingsBlock}\n\nRubric (what a thorough answer for this incident should cover):\n${rubric}\n\nAI agent's response to grade:\n${response}\n\nScore the AI agent's response 1-10 by comparing it holistically to the real report and rubric above.${referenceFindings ? " Also populate datasourceVerdicts for each ground-truth datasource listed above." : ""}`
		: `Rubric (what a thorough answer for this incident should cover -- no real incident report is available for this synthetic example, grade against the rubric alone):\n${rubric}\n\nResponse to grade:\n${response}\n\nScore the response 1-10 against the rubric.`;
	// CodeRabbit (PR #591): a request error here (network failure, rate limit, timeout) used to
	// throw out of the function, killing the whole eval run over one example -- the exact
	// fragility SIO-1221 fixed for JSON.parse below, just one call earlier. Degrade to the same
	// score-0 result the parse-failure path already returns.
	let r: Awaited<ReturnType<typeof openai.chat.completions.create>>;
	try {
		r = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			temperature: 0,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: HOLISTIC_JUDGE_SYSTEM_PROMPT },
				{ role: "user", content: userContent },
			],
		});
	} catch (err) {
		return {
			key: "response_quality",
			score: 0,
			comment: `judge request failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
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

// SIO-1374: the per-sub-agent judge, grading each datasource's serialized *Findings object
// (buildSubagentReports) against referenceFindings, isolating the variable under test (sub-agent
// model) from the constant (Sonnet 5 aggregator prose) -- the measurement gap this ticket exists
// to close. A separate schema/prompt/call from the holistic judge: it grades raw sub-agent
// findings, not the aggregator's final response text.
const SUBAGENT_ACCURACY_ENTRY_DEFAULT = { accuracy: "incorrect" as const, reasoning: "" };

// CodeRabbit (PR #591): a bare `.catch({})` on the outer record only rescues the record itself
// being malformed (not an object, missing entirely) -- z.record still fails as soon as ONE inner
// value is the wrong type, and that failure propagates straight to the outer .catch(), silently
// discarding every OTHER well-formed entry along with the bad one. Wrapping the per-value schema
// in its own .catch() degrades a malformed entry independently, so one bad datasource from a
// drifting judge never costs the whole example its subagent_accuracy_* feedback.
const TolerantSubagentAccuracyEntrySchema = z
	.object({
		accuracy: z.enum(["correct", "partial", "missing", "incorrect"]).catch("incorrect"),
		reasoning: z
			.union([z.string(), z.number(), z.null()])
			.optional()
			.transform((v) => (v === null || v === undefined ? "" : String(v))),
	})
	.catch(SUBAGENT_ACCURACY_ENTRY_DEFAULT);

export const SubagentGradeSchema = z.object({
	datasourceAccuracy: z.record(z.string(), TolerantSubagentAccuracyEntrySchema).catch({}),
});
export type SubagentGrade = z.output<typeof SubagentGradeSchema>;

// Pure mapping, unit-testable without an OpenAI call, same split as judgeFeedback.
export function subagentJudgeFeedback(grade: SubagentGrade): { key: string; score: number; comment: string }[] {
	return Object.entries(grade.datasourceAccuracy).map(([datasource, v]) => ({
		key: `subagent_accuracy_${datasource}`,
		score: v.accuracy === "correct" ? 1 : v.accuracy === "partial" ? 0.5 : 0,
		comment: `accuracy=${v.accuracy} -- ${v.reasoning}`,
	}));
}

const SUBAGENT_JUDGE_SYSTEM_PROMPT = [
	"You are grading raw sub-agent investigation findings (structured data one specialist tool-using agent produced for one datasource) against the real, human-curated ticket's own per-datasource findings for the same incident.",
	"You will be given, for each datasource: the sub-agent's own serialized findings (raw JSON, not prose -- do not penalize formatting or lack of narrative), and the real ticket's ground-truth finding for that same datasource.",
	"For EACH datasource provided, determine: 'correct' if the sub-agent's findings contain the same specific evidence/conclusion the ground truth describes; 'partial' if it contains related but incomplete or less specific evidence; 'missing' if the sub-agent produced no findings, or findings with no bearing on the ground truth, for that datasource; 'incorrect' if the sub-agent's findings actively contradict the ground truth.",
	"Grade each datasource independently -- do not let a strong result on one datasource influence the verdict on another.",
	'Respond with JSON: {"datasourceAccuracy": { "<datasource>": { "accuracy": "correct" | "partial" | "missing" | "incorrect", "reasoning": string (1-2 sentences) }, ... }}',
].join(" ");

// CodeRabbit (PR #591): buildSubagentReports concatenates every deployment's serialized
// findings for a datasource with no cap -- an example that fanned out across several
// deployments/estates could produce an oversized judge prompt. Caps each datasource's report
// independently (not the whole userContent) so a truncation always lands per-datasource with an
// explicit marker, never silently mid-JSON inside one report.
const SUBAGENT_REPORT_CHAR_CAP = 8_000;

export function truncateForJudge(text: string, capChars: number = SUBAGENT_REPORT_CHAR_CAP): string {
	if (text.length <= capChars) return text;
	const cut = text.length - capChars;
	return `${text.slice(0, capChars)}\n[truncated ${cut} chars for judge input size]`;
}

// Batches every datasource's sub-agent report + reference finding into ONE OpenAI call per
// example (not one call per datasource) to keep cost trivial on gpt-4o-mini -- SIO-1374 design
// doc's ~$1-2/32-example-leg target. Only datasources present in referenceFindings are graded:
// a datasource missing from referenceFindings has no ground truth to grade against (see Task 2's
// deliberate-omission note). A datasource missing from subagentReports still gets graded via a
// placeholder string so the judge can score it as "missing" evidence; this requires the
// referenceFindings entry to be meaningful, so the judge is only asked about datasources with
// reference ground truth to assess.
export async function judgeSubagentReports(
	subagentReports: { [dataSourceId: string]: string },
	referenceFindings: { [datasource: string]: string },
): Promise<{ key: string; score: number; comment: string }[]> {
	const datasources = Object.keys(referenceFindings);
	if (datasources.length === 0) return [];
	const openai = new OpenAI();
	const userContent = datasources
		.map((ds) => {
			const report = truncateForJudge(
				subagentReports[ds] ?? "(no findings produced by the sub-agent for this datasource)",
			);
			return `Datasource: ${ds}\nSub-agent's raw findings:\n${report}\nGround truth (from the real ticket):\n${referenceFindings[ds]}`;
		})
		.join("\n\n");
	// CodeRabbit (PR #591): an unhandled request error (network failure, rate limit, timeout) used
	// to throw out of this function, killing the whole eval run over one example -- the same
	// class of fragility SIO-1221 already fixed for responseQualityJudge's JSON.parse. Degrade to
	// no feedback for this example instead, matching the parse-failure path below.
	let r: Awaited<ReturnType<typeof openai.chat.completions.create>>;
	try {
		r = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			temperature: 0,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: SUBAGENT_JUDGE_SYSTEM_PROMPT },
				{ role: "user", content: userContent },
			],
		});
	} catch {
		return [];
	}
	const grade = parseLlmJson(r.choices[0]?.message?.content ?? "", SubagentGradeSchema);
	if (!grade.ok) return [];
	return subagentJudgeFeedback(grade.data);
}

// LangSmith run-evaluator entrypoint for the per-sub-agent judge (Task 7's judgeSubagentReports),
// mirroring responseQualityJudge's run/example -> feedback[] shape so it slots into the same
// evaluate() call registration as the existing evaluators.
export async function subagentEvidenceJudge(run: Run, example: Example) {
	// CodeRabbit (PR #591): example.outputs?.referenceFindings was previously an unchecked cast --
	// responseQualityJudge validates the same field through ExampleOutputsSchema, so a non-string
	// dataset value would silently interpolate as "[object Object]" in the judge prompt here while
	// failing loudly there. Sharing the schema keeps both evaluators on one contract.
	const parsedOutputs = ExampleOutputsSchema.safeParse(example.outputs ?? {});
	const referenceFindings = parsedOutputs.success ? (parsedOutputs.data.referenceFindings ?? {}) : {};
	const subagentReports =
		(run.outputs as { output?: { subagentReports?: { [k: string]: string } } } | undefined)?.output?.subagentReports ??
		{};
	if (Object.keys(referenceFindings).length === 0) return [];
	return judgeSubagentReports(subagentReports, referenceFindings);
}
