// packages/agent/src/eval/jev-citation-evaluator.ts
// SIO-1919/SIO-1935: the runbook-citation judge. One Noul per cited runbook: does every claim
// the report makes about it match the runbook's real content? It replaced a gpt-4o-mini JSON
// judge (key citation_grounding) that caught 1/8 planted contradictions to this one's 8/8 and
// failed 9/9 user-labelled real citations on relevance. The key stays citation_grounding_jev so
// old citation_grounding history never mixes with these scores in LangSmith Compare.
import type { Example, Run } from "langsmith/schemas";
import { askSystemOne, asNoul, resolveTypeSafeApiKey } from "../typesafe-client.ts";
import {
	type CitedRunbook,
	findCitedRunbooks,
	findUnknownMdCitations,
	readCitationGroundingOutput,
} from "./citation-grounding-evaluator.ts";

const KEY = "citation_grounding_jev";

// A citation by name alone is grounded: only an active misrepresentation fails.
export const GROUNDED_INSTRUCTIONS =
	"Every claim the report makes about what this runbook says or covers is supported by the runbook's real content. A report that only names the runbook without claiming anything about its content counts as supported.";

// At or above this the runbook counts as grounded. Planted contradictions scored 0.05-0.41 and real
// citations 0.58-0.85 (SIO-1935), so 0.5 sits in the gap.
export const GROUNDED_THRESHOLD = 0.5;

export type JevCitationResult =
	| { ok: true; probabilities: { filename: string; p: number }[] }
	| { ok: false; reason: string };

// Pure, unit-testable. Score is the MIN probability, not the mean: one misrepresented runbook
// fails the whole response, so a well-cited report cannot average away a bad citation. The raw
// probabilities go in the comment.
export function jevCitationFeedback(
	result: JevCitationResult,
	unknownFilenames: string[],
): { key: string; score?: number; comment: string }[] {
	if (unknownFilenames.length > 0) {
		return [
			{ key: KEY, score: 0, comment: `cited unknown/hallucinated runbook filename(s): ${unknownFilenames.join(", ")}` },
		];
	}
	if (!result.ok) return [{ key: KEY, comment: `Jev call failed, check did not run: ${result.reason}` }];
	if (result.probabilities.length === 0) return [];
	const min = Math.min(...result.probabilities.map((r) => r.p));
	const detail = result.probabilities.map((r) => `${r.filename}=${r.p.toFixed(3)}`).join(", ");
	return [
		{ key: KEY, score: min >= GROUNDED_THRESHOLD ? 1 : 0, comment: `min p(grounded)=${min.toFixed(3)}; ${detail}` },
	];
}

// One shared deadline for all of an example's requests. Not a latency budget (an eval is off the
// critical path) but a hang guard: LangSmith writes scores only after every example finishes, so a
// stalled TypeSafe connection would cost the whole experiment, not one score.
export const CITATION_DEADLINE_MS = 15000;

// One request per runbook: the state differs per runbook, and a batch of questions only shares one state.
export async function jevJudgeCitations(
	response: string,
	cited: CitedRunbook[],
	apiKey: string,
	signal: AbortSignal = AbortSignal.timeout(CITATION_DEADLINE_MS),
): Promise<JevCitationResult> {
	try {
		const probabilities = await Promise.all(
			cited.map(async (c) => {
				const answer = await askSystemOne({
					apiKey,
					signal,
					state: { report: response, runbook: { filename: c.filename, content: c.content } },
					questions: { grounded: { type: "noul", instructions: GROUNDED_INSTRUCTIONS } },
				});
				const p = asNoul(answer.answers.grounded)?.noul;
				if (p === undefined) throw new Error(`no noul answer for ${c.filename}`);
				return { filename: c.filename, p };
			}),
		);
		return { ok: true, probabilities };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

export async function jevCitationGrounding(
	run: Run,
	_example?: Example,
): Promise<{ key: string; score?: number; comment: string }[]> {
	const apiKey = resolveTypeSafeApiKey();
	if (!apiKey) return [];
	const input = readCitationGroundingOutput(run);
	if (!input) return [];

	const cited = findCitedRunbooks(input.response, input.candidates);
	// SIO-1921: a .md name quoted from sub-agent evidence is not an invented runbook.
	const unknownFilenames = findUnknownMdCitations(
		input.response,
		input.candidates.map((c) => c.filename),
		input.evidence,
	);
	if (cited.length === 0 && unknownFilenames.length === 0) return [];

	const result: JevCitationResult =
		cited.length === 0 ? { ok: true, probabilities: [] } : await jevJudgeCitations(input.response, cited, apiKey);
	return jevCitationFeedback(result, unknownFilenames);
}
