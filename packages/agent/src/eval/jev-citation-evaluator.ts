// packages/agent/src/eval/jev-citation-evaluator.ts
// SIO-1919: Jev twin of citationGrounding. Same citation detection and the same per-runbook
// question, asked as a Noul instead of an OpenAI JSON judge, so the two can run side by side and
// their agreement can be measured before either is trusted alone. Feedback key is distinct
// (citation_grounding_jev) so LangSmith Compare shows both columns.
import type { Example, Run } from "langsmith/schemas";
import { askSystemOne, asNoul, resolveTypeSafeApiKey } from "../typesafe-client.ts";
import {
	type CitedRunbook,
	findCitedRunbooks,
	findUnknownMdCitations,
	readCitationGroundingOutput,
} from "./citation-grounding-evaluator.ts";

const KEY = "citation_grounding_jev";

// Mirrors CITATION_GROUNDING_SYSTEM_PROMPT's rule, phrased as one statement to be true or false.
export const GROUNDED_INSTRUCTIONS =
	"Every claim the report makes about what this runbook says or covers is supported by the runbook's real content. A report that only names the runbook without claiming anything about its content counts as supported.";

// The LLM judge passes a runbook when grounded is true; a Noul at or above this is the same call.
export const GROUNDED_THRESHOLD = 0.5;

export type JevCitationResult =
	| { ok: true; probabilities: { filename: string; p: number }[] }
	| { ok: false; reason: string };

// Pure, unit-testable. Score is the MIN probability, not the mean: citationGrounding fails the
// whole response on one misrepresented runbook, and agreement is only measurable if both
// evaluators share that all-or-nothing shape. The raw probabilities go in the comment.
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

// One request per runbook: the state differs per runbook, and a batch of questions only shares one state.
export async function jevJudgeCitations(
	response: string,
	cited: CitedRunbook[],
	apiKey: string,
): Promise<JevCitationResult> {
	try {
		const probabilities = await Promise.all(
			cited.map(async (c) => {
				const answer = await askSystemOne({
					apiKey,
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
	// SIO-1921: same evidence exemption as citationGrounding, so the two stay comparable.
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
