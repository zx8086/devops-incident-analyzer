// packages/agent/src/eval/citation-grounding-evaluator.ts
// SIO-1442 tier 3: shared citation DETECTION for the runbook-citation evaluator. No structured
// citation convention exists in this codebase (the aggregator prompt renders each selected
// runbook under a "#### filename" heading with no instruction to cite it back), so detection is
// a best-effort filename/title match -- deliberately over-inclusive, since a missed citation is
// safe (fewer graded claims) but a fabricated match is not. Grounding itself (does the claim
// match the runbook's real content) is judged by Jev in jev-citation-evaluator.ts. SIO-1935
// retired the gpt-4o-mini judge that used to live here: it caught 1/8 planted contradictions
// and failed 9/9 user-labelled real citations on relevance rather than misrepresentation.
import type { Run } from "langsmith/schemas";
import { z } from "zod";

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
//
// SIO-1921: a name that ALSO appears in the sub-agent evidence is quoted, not invented -- e.g. a
// report listing the files an MR touched ("...Product.java and CHANGELOG.md") scored 0 here
// before any judge ran. An invented runbook name has no reason to appear in tool evidence.
export function findUnknownMdCitations(response: string, knownFilenames: string[], evidence = ""): string[] {
	const known = new Set(knownFilenames);
	const found = response.match(MD_FILENAME_PATTERN) ?? [];
	const inEvidence = new Set(evidence.match(MD_FILENAME_PATTERN) ?? []);
	return [...new Set(found.filter((name) => !known.has(name) && !inEvidence.has(name)))];
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
// by run-function.ts's runAgent, not at evaluation time. See readCitationGroundingOutput below for why:
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
// element, so readCitationGroundingOutput returns undefined and the evaluator emits no
// verdict instead of throwing or grading garbage.
const CitationGroundingOutputSchema = z.object({
	response: z.string(),
	knowledgeSnapshot: z.array(z.object({ filename: z.string(), content: z.string(), title: z.string() })).optional(),
	// SIO-1921: recorded on every fixture since the evaluator suite began, so replay-outputs works.
	subagentReports: z.record(z.string(), z.string()).optional(),
});

export function readCitationGroundingOutput(
	run: Run,
): { response: string; candidates: KnowledgeCitationCandidate[]; evidence: string } | undefined {
	const output = (run.outputs as { output?: unknown } | undefined)?.output;
	if (!output || typeof output !== "object") return undefined;
	const parsed = CitationGroundingOutputSchema.safeParse(output);
	if (!parsed.success) return undefined;
	return {
		response: parsed.data.response,
		candidates: parsed.data.knowledgeSnapshot ?? [],
		evidence: Object.values(parsed.data.subagentReports ?? {}).join("\n"),
	};
}
