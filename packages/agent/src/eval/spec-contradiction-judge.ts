// packages/agent/src/eval/spec-contradiction-judge.ts
// SIO-1440 check 1: flags RULES.md constraints that conflict with SOUL.md identity claims.
// SIO-1257's ban-pattern scan (packages/gitagent-bridge/src/skill-tool-coverage.test.ts) only
// catches ONE contradiction shape ("prose defers to a human"); general SOUL-vs-RULES conflict
// is not regex-able, so this is an LLM-assisted lint -- one cheap call per agent manifest, no
// graph execution, mirroring judgeSubagentReports/responseQualityJudge's shape in evaluators.ts.
import OpenAI from "openai";
import { z } from "zod";
import { parseLlmJson } from "../llm-json.ts";
import { judgeModelConfig } from "./evaluators.ts";

const ContradictionSchema = z.object({
	soulClaim: z.string(),
	rulesConstraint: z.string(),
	severity: z.enum(["low", "medium", "high"]).catch("low" as const),
});

export const ContradictionGradeSchema = z.object({
	contradictions: z.array(ContradictionSchema).catch([]),
});
export type ContradictionGrade = z.output<typeof ContradictionGradeSchema>;

export const SPEC_CONTRADICTION_SYSTEM_PROMPT = [
	"You audit an AI agent's specification for internal contradictions between its identity",
	"document (SOUL.md) and its constraints document (RULES.md).",
	"",
	"A contradiction is a genuine conflict: SOUL.md implies or states the agent MAY or SHOULD do",
	"something that RULES.md explicitly forbids, or vice versa (RULES.md permits something SOUL.md's",
	"identity rules out). Do NOT flag constraints that are merely complementary, more specific, or",
	"additive -- RULES.md narrowing a broad SOUL.md capability is normal spec design, not a",
	"contradiction. Only flag a genuine either/or conflict a reader could not resolve without",
	"picking one document over the other.",
	"",
	'Respond with JSON: { "contradictions": [ { "soulClaim": string, "rulesConstraint": string,',
	'"severity": "low"|"medium"|"high" } ] }. Empty array when there are no contradictions.',
].join("\n");

// Pure, unit-testable without an OpenAI call -- same split as evaluators.ts's judge functions.
export function buildContradictionScanInput(soul: string, rules: string): string {
	return `SOUL.md:\n${soul}\n\nRULES.md:\n${rules}`;
}

const SEVERITY_RANK: Record<ContradictionGrade["contradictions"][number]["severity"], number> = {
	low: 0,
	medium: 1,
	high: 2,
};

// CodeRabbit (PR #630): a failed judge call (network error, missing/malformed JSON, invalid
// schema) must NOT collapse to the same shape as "the judge ran and found nothing" -- that
// silently reported a passing score for a check that never actually ran. This discriminated
// union forces every caller to handle failure as its own case rather than defaulting through it.
export type ContradictionScanResult = { ok: true; grade: ContradictionGrade } | { ok: false; reason: string };

// Pure mapping, unit-testable without an OpenAI call, same split as subagentJudgeFeedback.
// score is omitted (not defaulted to a number) on judge failure, so a LangSmith consumer sees
// "no score recorded" rather than a false pass or an arbitrary sentinel fail value.
export function contradictionJudgeFeedback(
	result: ContradictionScanResult,
	agentName: string,
): { key: string; score?: number; comment: string }[] {
	const key = `spec_contradiction_${agentName}`;
	if (!result.ok) {
		return [{ key, comment: `judge call failed, check did not run: ${result.reason}` }];
	}
	const { grade } = result;
	if (grade.contradictions.length === 0) {
		return [{ key, score: 1, comment: "no contradictions found" }];
	}
	const worst = grade.contradictions.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a));
	return [
		{
			key,
			score: 0,
			comment: `${grade.contradictions.length} contradiction(s) found, worst severity: ${worst.severity}`,
		},
	];
}

// Live OpenAI call. Deliberately thin and untested by unit tests -- mirrors
// judgeSubagentReports/responseQualityJudge's own openai.chat.completions.create call, which
// carries the same integration-boundary exemption in evaluators.test.ts.
export async function judgeSpecContradictions(soul: string, rules: string): Promise<ContradictionScanResult> {
	const openai = new OpenAI();
	let r: Awaited<ReturnType<typeof openai.chat.completions.create>>;
	try {
		r = await openai.chat.completions.create({
			...judgeModelConfig(),
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: SPEC_CONTRADICTION_SYSTEM_PROMPT },
				{ role: "user", content: buildContradictionScanInput(soul, rules) },
			],
		});
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
	const parsed = parseLlmJson(r.choices[0]?.message?.content ?? "", ContradictionGradeSchema);
	return parsed.ok ? { ok: true, grade: parsed.data } : { ok: false, reason: parsed.message };
}
