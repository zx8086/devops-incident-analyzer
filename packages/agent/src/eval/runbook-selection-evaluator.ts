// packages/agent/src/eval/runbook-selection-evaluator.ts
// SIO-1442 tier 3: did the agent honor the SIO-640 runbook-selection contract? The LLM router
// (runSelectRunbooks) picks 0-3 runbooks by trigger relevance -- fallbackBySeverity is an
// emergency fallback consulted only when the router itself fails, NOT a "correct answer" a
// successful run should match, so this evaluator does not grade against it. The one binding,
// unconditional part of the contract is always_select (SIO-1302: "appended... on every complex
// turn, unconditionally... Policy: all incidents in this system are software incidents"). This
// evaluator grades that guarantee: did every always_select runbook actually make it into
// state.selectedRunbooks.
import type { Example, Run } from "langsmith/schemas";
import { getAgent } from "../prompt-context.ts";

export interface RunbookSelectionInput {
	severity: "critical" | "high" | "medium" | "low" | undefined;
	selectedRunbooks: string[] | null;
	fallbackBySeverity: Record<"critical" | "high" | "medium" | "low", string[]>;
	alwaysSelect: string[];
}

export interface RunbookSelectionVerdict {
	score: number;
	missing: string[];
}

// Pure, unit-testable without touching run.outputs or getAgent(). null return means "no
// verdict" -- either the selector node never ran this turn (selectedRunbooks === null, e.g. a
// simple/non-complex turn has no selection decision to grade) or severity is unknown (nothing
// to compare against). Both are "not applicable," not failures.
export function compareRunbookSelection(input: RunbookSelectionInput): RunbookSelectionVerdict | null {
	if (input.severity === undefined) return null;
	if (input.selectedRunbooks === null) return null;

	const selected = new Set(input.selectedRunbooks);
	const missing = input.alwaysSelect.filter((filename) => !selected.has(filename));
	return { score: missing.length === 0 ? 1 : 0, missing };
}

function readRunbookSelectionOutput(
	run: Run,
): { selectedRunbooks: string[] | null; severity: RunbookSelectionInput["severity"] } | undefined {
	const output = (run.outputs as { output?: { selectedRunbooks?: unknown; severity?: unknown } } | undefined)?.output;
	if (!output) return undefined;
	const selectedRunbooks =
		Array.isArray(output.selectedRunbooks) || output.selectedRunbooks === null
			? (output.selectedRunbooks as string[] | null)
			: null;
	const severity =
		typeof output.severity === "string" && ["critical", "high", "medium", "low"].includes(output.severity)
			? (output.severity as RunbookSelectionInput["severity"])
			: undefined;
	return { selectedRunbooks, severity };
}

// LangSmith run-evaluator entrypoint. Reads run.outputs.output.selectedRunbooks/severity
// (threaded by run-function.ts's runAgent, mirroring toolTrajectory/responseHealth) and the
// live agent's runbook_selection contract from knowledge/index.yaml via getAgent() -- the same
// source runSelectRunbooksNode itself reads at runtime, so ground truth can never drift from
// the config that actually governed the run being graded.
export function runbookSelectionVsUsage(
	run: Run,
	_example?: Example,
): { key: string; score: number; comment: string }[] {
	const output = readRunbookSelectionOutput(run);
	if (!output) return [];

	const agent = getAgent();
	if (!agent.runbookSelection) return [];

	const verdict = compareRunbookSelection({
		severity: output.severity,
		selectedRunbooks: output.selectedRunbooks,
		fallbackBySeverity: agent.runbookSelection.fallback_by_severity,
		alwaysSelect: agent.runbookSelection.always_select ?? [],
	});
	if (!verdict) return [];

	const comment =
		verdict.missing.length === 0
			? "all always_select runbooks present"
			: `missing always_select runbook(s): ${verdict.missing.join(", ")}`;
	return [{ key: "runbook_selection_vs_usage", score: verdict.score, comment }];
}
