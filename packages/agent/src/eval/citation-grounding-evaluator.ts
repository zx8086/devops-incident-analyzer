// packages/agent/src/eval/citation-grounding-evaluator.ts
// SIO-1442 tier 3: catches hallucinated runbook citations -- a response that names a real
// runbook but misrepresents what it actually says, or (implicitly, via findCitedRunbooks
// returning no match) invents content attributed to a runbook that isn't in the response's
// visible citation set at all. No structured citation convention exists in this codebase (the
// aggregator prompt renders each selected runbook under a "#### filename" heading with no
// instruction to cite it back), so citation DETECTION is a best-effort filename/title match --
// deliberately over-inclusive, since a missed citation is safe (fewer graded claims) but a
// fabricated match is not. Grounding itself (does the claim match the runbook's real content)
// is semantic and not regex-able, so it's an LLM judge, same pattern as SIO-1440's
// spec-contradiction-judge.ts (judgeSpecContradictions / judgeCitationGrounding split).
import type { Example, Run } from "langsmith/schemas";
import OpenAI from "openai";
import { z } from "zod";
import { parseLlmJson } from "../llm-json.ts";
import { getAgent } from "../prompt-context.ts";
import { judgeModelConfig } from "./evaluators.ts";

export interface KnowledgeCitationCandidate {
	filename: string;
	content: string;
	title: string;
}

export interface CitedRunbook {
	filename: string;
	content: string;
}

// Escapes regex metacharacters so a title/filename containing them (e.g. "N1QL Investigation
// (v2)") is matched literally, not interpreted as a pattern.
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pure, unit-testable without touching real knowledge or an LLM. Matches on the filename OR the
// runbook's title text appearing in the response -- a word-boundary match so "database-slow-
// queries.md" doesn't match a mid-word substring, and title matching catches prose that names
// the procedure without the literal .md filename. Dedups by filename: a runbook cited twice in
// one response is graded once.
export function findCitedRunbooks(response: string, knowledge: KnowledgeCitationCandidate[]): CitedRunbook[] {
	const cited = new Map<string, CitedRunbook>();
	for (const entry of knowledge) {
		const filenamePattern = new RegExp(`\\b${escapeRegExp(entry.filename)}\\b`);
		const titlePattern = entry.title.trim() ? new RegExp(`\\b${escapeRegExp(entry.title.trim())}\\b`, "i") : null;
		if (filenamePattern.test(response) || (titlePattern?.test(response) ?? false)) {
			cited.set(entry.filename, { filename: entry.filename, content: entry.content });
		}
	}
	return [...cited.values()];
}

const CitationVerdictSchema = z.object({
	filename: z.string(),
	grounded: z.boolean(),
	reasoning: z.string(),
});

export const CitationGradeSchema = z.object({
	verdicts: z.array(CitationVerdictSchema),
});
export type CitationGrade = z.output<typeof CitationGradeSchema>;

export const CITATION_GROUNDING_SYSTEM_PROMPT = [
	"You verify whether an incident-response report's claims about a cited runbook are actually",
	"supported by that runbook's real content.",
	"",
	"For EACH runbook provided, you are given the report's surrounding claim (the response text) and",
	"the runbook's actual full content. Determine 'grounded: true' if the report's claim about what",
	"the runbook says or covers is accurate and supported by the runbook's real content. Determine",
	"'grounded: false' if the report misattributes content to the runbook, claims the runbook covers",
	"something it does not, or otherwise misrepresents what the runbook actually says.",
	"",
	"Citing a runbook by name without making any specific claim about its content is grounded (true)",
	"-- there is nothing to misrepresent. Only flag an ACTIVE misrepresentation.",
	"",
	'Respond with JSON: { "verdicts": [ { "filename": string, "grounded": boolean, "reasoning": string',
	"(1-2 sentences) } ] } -- one verdict per runbook provided, in the order given.",
].join("\n");

// Pure, unit-testable without an OpenAI call -- same split as evaluators.ts's judge functions.
export function buildCitationScanInput(response: string, cited: CitedRunbook[]): string {
	return cited
		.map(
			(c) =>
				`Runbook: ${c.filename}\nReport's response text (containing the citation):\n${response}\n\nRunbook's real content:\n${c.content}`,
		)
		.join("\n\n---\n\n");
}

// Same failure-isolation shape as SIO-1440's ContradictionScanResult: a failed judge call must
// not collapse to the same shape as "the judge ran and found everything grounded."
export type CitationScanResult = { ok: true; verdicts: CitationGrade["verdicts"] } | { ok: false; reason: string };

// Pure mapping, unit-testable without an OpenAI call, same split as contradictionJudgeFeedback.
// score is omitted (not defaulted) on judge failure so a LangSmith consumer sees "no score
// recorded" rather than a false pass.
export function citationJudgeFeedback(result: CitationScanResult): { key: string; score?: number; comment: string }[] {
	const key = "citation_grounding";
	if (!result.ok) {
		return [{ key, comment: `judge call failed, check did not run: ${result.reason}` }];
	}
	if (result.verdicts.length === 0) return [];

	const ungrounded = result.verdicts.filter((v) => !v.grounded);
	if (ungrounded.length === 0) {
		return [
			{
				key,
				score: 1,
				comment: `${result.verdicts.length}/${result.verdicts.length} citation(s) grounded in real runbook content`,
			},
		];
	}
	return [
		{
			key,
			score: 0,
			comment: `misrepresented citation(s): ${ungrounded.map((v) => `${v.filename} (${v.reasoning})`).join("; ")}`,
		},
	];
}

// Live OpenAI call. Deliberately thin and untested by unit tests -- mirrors
// judgeSpecContradictions/judgeSubagentReports' own openai.chat.completions.create call.
export async function judgeCitationGrounding(response: string, cited: CitedRunbook[]): Promise<CitationScanResult> {
	if (cited.length === 0) return { ok: true, verdicts: [] };
	const openai = new OpenAI();
	let r: Awaited<ReturnType<typeof openai.chat.completions.create>>;
	try {
		r = await openai.chat.completions.create({
			...judgeModelConfig(),
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: CITATION_GROUNDING_SYSTEM_PROMPT },
				{ role: "user", content: buildCitationScanInput(response, cited) },
			],
		});
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
	const parsed = parseLlmJson(r.choices[0]?.message?.content ?? "", CitationGradeSchema);
	return parsed.ok ? { ok: true, verdicts: parsed.data.verdicts } : { ok: false, reason: parsed.message };
}

// KnowledgeEntry (manifest-loader.ts) does not carry a title field through -- OKF frontmatter's
// `title:` is parsed but dropped at the loader boundary, only triggers/status/staleAfter survive
// into the entry. Every runbook in this repo puts its title as the first "# Heading" line of the
// stripped content (confirmed: all 10 current runbooks follow this), so derive title from there
// rather than touching the shared loader for one evaluator's benefit. "" (not found) degrades
// findCitedRunbooks to filename-only matching for that entry, never a crash.
export function deriveTitleFromContent(content: string): string {
	const match = content.match(/^#\s+(.+)$/m);
	return match?.[1]?.trim() ?? "";
}

function readResponse(run: Run): string | undefined {
	const response = (run.outputs as { output?: { response?: unknown } } | undefined)?.output?.response;
	return typeof response === "string" ? response : undefined;
}

// LangSmith run-evaluator entrypoint. Reads run.outputs.output.response and the live agent's
// runbook knowledge via getAgent() (the same source the aggregator prompt itself renders runbook
// content from), so citation ground truth can never drift from what was actually available to
// the model that produced the response being graded.
export async function citationGrounding(
	run: Run,
	_example?: Example,
): Promise<{ key: string; score?: number; comment: string }[]> {
	const response = readResponse(run);
	if (!response) return [];

	const agent = getAgent();
	const candidates: KnowledgeCitationCandidate[] = agent.knowledge
		.filter((entry) => entry.filename.endsWith(".md"))
		.map((entry) => ({
			filename: entry.filename,
			content: entry.content,
			title: deriveTitleFromContent(entry.content),
		}));

	const cited = findCitedRunbooks(response, candidates);
	if (cited.length === 0) return [];

	const result = await judgeCitationGrounding(response, cited);
	return citationJudgeFeedback(result);
}
