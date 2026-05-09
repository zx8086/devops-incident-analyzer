// packages/agent/src/eval/evaluators.ts
import type { Example, Run } from "langsmith/schemas";
import OpenAI from "openai";

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
// Rubrics in dataset.ts must grade response content, not trajectory facts the judge can't observe.
//
// The system prompt below was hardened after SIO-692 verification showed gpt-4o-mini
// at temperature 0 was systematically reading rubric clauses literally and missing
// semantically equivalent content (e.g. judging "does not reference recent GitLab
// deploys" against a response that cites specific GitLab commit SHAs and merge dates).
// The "semantic equivalence" + "concrete evidence counts" framing keeps strictness
// against truly absent content while accepting reworded coverage of present content.
const JUDGE_SYSTEM_PROMPT = [
	"You grade an incident-response message against a rubric. Each rubric clause is a separate requirement.",
	"A clause is met when the response demonstrates its substance, not when it uses identical wording.",
	"Concrete evidence counts: specific commit SHAs, service names, timestamps, indices, or upstream URLs satisfy clauses that ask for 'references' or 'cites' of those things, even if the rubric phrases the requirement abstractly.",
	"Mark meets_rubric=true if every clause is substantively addressed, false if any clause is genuinely absent.",
	"In reasoning, list each clause and one short sentence on whether the response addresses it.",
	'Respond with JSON: {"meets_rubric": boolean, "reasoning": string}',
].join(" ");

export async function responseQualityJudge(run: Run, example: Example) {
	const rubric = example.outputs?.qualityRubric as string | undefined;
	const response = (run.outputs as { output?: { response?: string } } | undefined)?.output?.response;
	if (!rubric || !response) {
		return { key: "response_quality", score: 0, comment: "missing rubric or response" };
	}
	const openai = new OpenAI();
	const r = await openai.chat.completions.create({
		model: "gpt-4o-mini",
		temperature: 0,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: JUDGE_SYSTEM_PROMPT },
			{
				role: "user",
				content: `Rubric: ${rubric}\n\nResponse to grade:\n${response}\n\nDoes the response meet every rubric clause?`,
			},
		],
	});
	const grade = JSON.parse(r.choices[0]?.message?.content ?? '{"meets_rubric":false,"reasoning":"empty response"}');
	return { key: "response_quality", score: grade.meets_rubric ? 1 : 0, comment: String(grade.reasoning ?? "") };
}
