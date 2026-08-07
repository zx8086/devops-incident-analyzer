// packages/agent/src/eval/runbook-selection-evaluator.ts
// SIO-1442 tier 3: did the agent honor the SIO-640 runbook-selection contract? The LLM router
// (runSelectRunbooks) picks 0-3 runbooks by trigger relevance -- fallbackBySeverity is an
// emergency fallback consulted only when the router itself fails, NOT a "correct answer" a
// successful run should match, so this evaluator does not grade against it (and does not read
// severity at all -- see CodeRabbit PR #633: an earlier version gated grading on severity being
// present even though the comparison never used it, so a run with a completed selection but no
// populated normalizedIncident.severity silently skipped a gradable contract). The one binding,
// unconditional part of the contract is always_select (SIO-1302: "appended... on every complex
// turn, unconditionally... Policy: all incidents in this system are software incidents"). This
// evaluator grades that guarantee: did every always_select runbook actually make it into
// state.selectedRunbooks.
//
// CodeRabbit (PR #633): this evaluator originally called getAgent() LIVE to read
// runbookSelection.always_select, so re-grading a recorded run under replay-outputs graded
// against TODAY's config rather than the config that governed the run when it was recorded --
// editing always_select after recording a fixture would silently change historical scores.
// alwaysSelectRunbooks is now snapshotted by run-function.ts's runAgent at the moment the run
// actually executes (same pattern as selectedRunbooks/toolTrajectory), so this evaluator reads
// only run.outputs -- no live config, ever.
import type { Example, Run } from "langsmith/schemas";
import { z } from "zod";

export interface RunbookSelectionInput {
	selectedRunbooks: string[] | null;
	alwaysSelect: string[];
}

// CodeRabbit (PR #633, round 3): the previous Array.isArray(...) checks validated the array
// wrapper but not element shape -- a malformed element (e.g. a number in selectedRunbooks, an
// object in alwaysSelectRunbooks) passed through and either produced a silently wrong score
// (missing.filter comparing a string Set against non-string elements never matches) or would
// throw downstream. z.array(z.string()) rejects the whole array if any element is the wrong
// type, so malformed run.outputs fails loudly (readRunbookSelectionOutput returns undefined,
// runbookSelectionVsUsage emits no verdict) instead of grading garbage.
const RunbookSelectionOutputSchema = z.object({
	selectedRunbooks: z.array(z.string()).nullable().optional(),
	alwaysSelectRunbooks: z.array(z.string()).optional(),
});

export interface RunbookSelectionVerdict {
	score: number;
	missing: string[];
}

// Pure, unit-testable without touching run.outputs or getAgent(). null return means "no
// verdict" -- the selector node never ran this turn (selectedRunbooks === null, e.g. a
// simple/non-complex turn has no selection decision to grade). Not a failure.
export function compareRunbookSelection(input: RunbookSelectionInput): RunbookSelectionVerdict | null {
	if (input.selectedRunbooks === null) return null;

	const selected = new Set(input.selectedRunbooks);
	const missing = input.alwaysSelect.filter((filename) => !selected.has(filename));
	return { score: missing.length === 0 ? 1 : 0, missing };
}

export function readRunbookSelectionOutput(run: Run): RunbookSelectionInput | undefined {
	const output = (run.outputs as { output?: unknown } | undefined)?.output;
	if (!output || typeof output !== "object") return undefined;
	const parsed = RunbookSelectionOutputSchema.safeParse(output);
	if (!parsed.success) return undefined;
	return {
		selectedRunbooks: parsed.data.selectedRunbooks ?? null,
		alwaysSelect: parsed.data.alwaysSelectRunbooks ?? [],
	};
}

// LangSmith run-evaluator entrypoint. Reads run.outputs.output.selectedRunbooks/
// alwaysSelectRunbooks only (both threaded by run-function.ts's runAgent, mirroring
// toolTrajectory/responseHealth) -- no live config read, so replay-outputs re-grades against
// the config that actually governed the run being graded, not whatever exists today.
export function runbookSelectionVsUsage(
	run: Run,
	_example?: Example,
): { key: string; score: number; comment: string }[] {
	const input = readRunbookSelectionOutput(run);
	if (!input) return [];

	const verdict = compareRunbookSelection(input);
	if (!verdict) return [];

	const comment =
		verdict.missing.length === 0
			? "all always_select runbooks present"
			: `missing always_select runbook(s): ${verdict.missing.join(", ")}`;
	return [{ key: "runbook_selection_vs_usage", score: verdict.score, comment }];
}
