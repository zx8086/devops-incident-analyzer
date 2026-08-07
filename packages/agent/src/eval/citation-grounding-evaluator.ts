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

// Matches any bare token shaped like "some-name.md" -- a plausible runbook filename citation --
// independent of whether it is a real, known runbook. Requires a filename-safe character class
// (no spaces) so ordinary prose ("the database was slow") never matches; a real .md reference is
// always a single contiguous token in practice (this codebase's runbook filenames are kebab-case).
const MD_FILENAME_PATTERN = /\b[a-zA-Z0-9][a-zA-Z0-9_-]*\.md\b/g;

// CodeRabbit (PR #633): findCitedRunbooks alone only ever matches a KNOWN filename -- a response
// citing a completely invented filename produced no match at all, missing the exact
// hallucination case this evaluator exists to catch. Scans independently for anything
// filename-shaped and flags names not in the known set. Deduped, order-independent.
export function findUnknownMdCitations(response: string, knownFilenames: string[]): string[] {
	const known = new Set(knownFilenames);
	const found = response.match(MD_FILENAME_PATTERN) ?? [];
	return [...new Set(found.filter((name) => !known.has(name)))];
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

// CodeRabbit (PR #633): the system prompt ASKS (in prose) for "one verdict per runbook
// provided, in the order given," but CitationGradeSchema only validates shape, not coverage -- a
// response with zero verdicts, a subset, duplicates, or verdicts for unrelated filenames still
// passes schema validation. Order does not matter here (only exact-set membership does); the
// prompt's "in the order given" is a hint for the model, not something this check enforces.
export function validateVerdictCoverage(verdicts: CitationGrade["verdicts"], cited: CitedRunbook[]): boolean {
	if (verdicts.length !== cited.length) return false;
	const citedFilenames = new Set(cited.map((c) => c.filename));
	const verdictFilenames = new Set(verdicts.map((v) => v.filename));
	if (verdictFilenames.size !== verdicts.length) return false; // duplicate filename in verdicts
	if (verdictFilenames.size !== citedFilenames.size) return false;
	for (const filename of verdictFilenames) {
		if (!citedFilenames.has(filename)) return false;
	}
	return true;
}

// Same failure-isolation shape as SIO-1440's ContradictionScanResult: a failed judge call must
// not collapse to the same shape as "the judge ran and found everything grounded."
export type CitationScanResult = { ok: true; verdicts: CitationGrade["verdicts"] } | { ok: false; reason: string };

// Pure mapping, unit-testable without an OpenAI call, same split as contradictionJudgeFeedback.
// score is omitted (not defaulted) on judge failure so a LangSmith consumer sees "no score
// recorded" rather than a false pass. unknownFilenames (CodeRabbit PR #633) is graded
// independently of the judge verdicts -- a hallucinated filename is itself the finding, reported
// even when there were no known citations to send to the judge at all.
export function citationJudgeFeedback(
	result: CitationScanResult,
	unknownFilenames: string[],
): { key: string; score?: number; comment: string }[] {
	const key = "citation_grounding";

	// Checked before result.ok: an unknown filename is detected independently of the judge (no
	// OpenAI call needed), so a failed judge call for a separate, real citation must never mask an
	// already-certain hallucination finding.
	if (unknownFilenames.length > 0) {
		return [
			{
				key,
				score: 0,
				comment: `cited unknown/hallucinated runbook filename(s): ${unknownFilenames.join(", ")}`,
			},
		];
	}

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
	if (!parsed.ok) return { ok: false, reason: parsed.message };
	if (!validateVerdictCoverage(parsed.data.verdicts, cited)) {
		return {
			ok: false,
			reason: `judge returned incomplete/mismatched verdict coverage: expected ${cited.length} verdict(s) for [${cited.map((c) => c.filename).join(", ")}], got ${JSON.stringify(parsed.data.verdicts.map((v) => v.filename))}`,
		};
	}
	return { ok: true, verdicts: parsed.data.verdicts };
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

// Snapshots the current agent's runbook knowledge as citation candidates -- called at RUN time
// by run-function.ts's runAgent, not at evaluation time. See citationGrounding below for why:
// this used to be read live via getAgent() inside the evaluator itself, which broke
// replay-outputs (CodeRabbit PR #633).
export function buildKnowledgeCandidates(
	knowledge: { filename: string; content: string }[],
): KnowledgeCitationCandidate[] {
	return knowledge
		.filter((entry) => entry.filename.endsWith(".md"))
		.map((entry) => ({
			filename: entry.filename,
			content: entry.content,
			title: deriveTitleFromContent(entry.content),
		}));
}

// CodeRabbit (PR #633, round 3): the previous Array.isArray(...) check validated the array
// wrapper but not element shape -- a malformed knowledgeSnapshot element (null, {}, a number)
// passed through and crashed downstream in findCitedRunbooks (entry.title.trim() on a missing
// title). z.array(...) with a full element shape rejects the whole array on any malformed
// element, so readCitationGroundingOutput returns undefined and citationGrounding emits no
// verdict instead of throwing or grading garbage.
const CitationGroundingOutputSchema = z.object({
	response: z.string(),
	knowledgeSnapshot: z.array(z.object({ filename: z.string(), content: z.string(), title: z.string() })).optional(),
});

export function readCitationGroundingOutput(
	run: Run,
): { response: string; candidates: KnowledgeCitationCandidate[] } | undefined {
	const output = (run.outputs as { output?: unknown } | undefined)?.output;
	if (!output || typeof output !== "object") return undefined;
	const parsed = CitationGroundingOutputSchema.safeParse(output);
	if (!parsed.success) return undefined;
	return { response: parsed.data.response, candidates: parsed.data.knowledgeSnapshot ?? [] };
}

// LangSmith run-evaluator entrypoint. Reads run.outputs.output.response/knowledgeSnapshot only
// (both threaded by run-function.ts's runAgent) -- no live config read. CodeRabbit (PR #633):
// this originally called getAgent() live at evaluation time, so re-grading a recorded run under
// replay-outputs used TODAY's runbook content, not the content actually available to the model
// that produced the response when the run was recorded -- editing a runbook after recording a
// fixture would silently change historical citation-grounding scores.
export async function citationGrounding(
	run: Run,
	_example?: Example,
): Promise<{ key: string; score?: number; comment: string }[]> {
	const input = readCitationGroundingOutput(run);
	if (!input) return [];

	const cited = findCitedRunbooks(input.response, input.candidates);
	const unknownFilenames = findUnknownMdCitations(
		input.response,
		input.candidates.map((c) => c.filename),
	);
	if (cited.length === 0 && unknownFilenames.length === 0) return [];

	const result = await judgeCitationGrounding(input.response, cited);
	return citationJudgeFeedback(result, unknownFilenames);
}
