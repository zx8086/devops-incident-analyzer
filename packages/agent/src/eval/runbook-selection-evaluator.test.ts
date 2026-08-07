// packages/agent/src/eval/runbook-selection-evaluator.test.ts
// SIO-1442: did the agent honor the SIO-640 always_select contract? Pure comparison logic tested
// here; the live run.outputs/getAgent() reading glue (runbookSelectionVsUsage) is thin and
// untested by unit tests, same split as SIO-1440's spec-contradiction-judge.ts
// (judgeSpecContradictions vs contradictionJudgeFeedback).
//
// CodeRabbit (PR #633): compareRunbookSelection originally gated always_select grading on
// severity being present, even though always_select is unconditional (SIO-1302: "appended...
// every complex turn, unconditionally... all incidents are software incidents") and the
// comparison logic never actually read severity or fallbackBySeverity. A run with a completed
// selection but no populated normalizedIncident.severity (plausible -- it's .optional()) would
// silently skip grading a real, gradable contract. Removed severity/fallbackBySeverity from the
// input entirely -- they were dead weight the comparison logic never used.
import { describe, expect, test } from "bun:test";
import { compareRunbookSelection } from "./runbook-selection-evaluator.ts";

const alwaysSelect = ["code-change-correlation.md"];

describe("compareRunbookSelection", () => {
	test("always_select present scores 1", () => {
		const verdict = compareRunbookSelection({
			selectedRunbooks: ["code-change-correlation.md"],
			alwaysSelect,
		});
		expect(verdict).not.toBeNull();
		expect(verdict?.score).toBe(1);
		expect(verdict?.missing).toEqual([]);
	});

	test("missing an always_select entry scores 0 and names it", () => {
		const verdict = compareRunbookSelection({
			selectedRunbooks: ["kafka-consumer-lag.md"],
			alwaysSelect,
		});
		expect(verdict).not.toBeNull();
		expect(verdict?.score).toBe(0);
		expect(verdict?.missing).toEqual(["code-change-correlation.md"]);
	});

	test("a superset of always_select still scores 1 (extra runbooks are not a defect)", () => {
		const verdict = compareRunbookSelection({
			selectedRunbooks: ["kafka-consumer-lag.md", "high-error-rate.md", "code-change-correlation.md"],
			alwaysSelect,
		});
		expect(verdict?.score).toBe(1);
	});

	// selectedRunbooks is state.ts's tri-state: null means the selector node never ran this
	// turn (e.g. a simple/non-complex turn) -- there is no selection decision to grade, so this
	// must emit no verdict rather than a false failure.
	test("selectedRunbooks === null (selector did not run) yields no verdict", () => {
		const verdict = compareRunbookSelection({
			selectedRunbooks: null,
			alwaysSelect,
		});
		expect(verdict).toBeNull();
	});

	test("an empty selection when always_select is empty scores 1, not a false failure", () => {
		const verdict = compareRunbookSelection({
			selectedRunbooks: [],
			alwaysSelect: [],
		});
		expect(verdict?.score).toBe(1);
	});

	// The regression this guards: grading must not depend on severity being populated, since
	// always_select is unconditional and has nothing to do with severity.
	test("grades always_select regardless of severity -- there is no severity parameter at all", () => {
		const verdict = compareRunbookSelection({
			selectedRunbooks: ["kafka-consumer-lag.md"],
			alwaysSelect,
		});
		expect(verdict).not.toBeNull();
		expect(verdict?.score).toBe(0);
	});
});
