// packages/agent/src/eval/runbook-selection-evaluator.test.ts
// SIO-1442: did the agent select the runbook(s) the SIO-640 contract says it should have, for
// this incident's severity? Pure comparison logic tested here; the live run.outputs/getAgent()
// reading glue (runbookSelectionVsUsage) is thin and untested by unit tests, same split as
// SIO-1440's spec-contradiction-judge.ts (judgeSpecContradictions vs contradictionJudgeFeedback).
import { describe, expect, test } from "bun:test";
import { compareRunbookSelection } from "./runbook-selection-evaluator.ts";

const fallbackBySeverity = {
	critical: ["kafka-consumer-lag.md", "high-error-rate.md", "database-slow-queries.md", "code-change-correlation.md"],
	high: ["kafka-consumer-lag.md", "high-error-rate.md", "database-slow-queries.md", "code-change-correlation.md"],
	medium: ["code-change-correlation.md"],
	low: [],
};
const alwaysSelect = ["code-change-correlation.md"];

describe("compareRunbookSelection", () => {
	test("exact match against the severity fallback scores 1", () => {
		const verdict = compareRunbookSelection({
			severity: "medium",
			selectedRunbooks: ["code-change-correlation.md"],
			fallbackBySeverity,
			alwaysSelect,
		});
		expect(verdict).not.toBeNull();
		expect(verdict?.score).toBe(1);
		expect(verdict?.missing).toEqual([]);
	});

	// The LLM router (runSelectRunbooks) picks 0-3 runbooks by trigger relevance, not by blindly
	// copying the severity fallback -- the fallback only fires when the router itself fails. A
	// router pick that omits some fallback entries is normal, expected behavior, not a defect.
	// The contract this evaluator actually enforces is always_select: those must ALWAYS appear,
	// router or fallback, every complex turn, unconditionally (runbook-selector.ts's SIO-1302
	// comment). Only always_select entries count toward "missing" -- the wider severity list is
	// informational context, not itself pass/fail.
	test("missing an always_select entry scores 0 and names it", () => {
		const verdict = compareRunbookSelection({
			severity: "critical",
			selectedRunbooks: ["kafka-consumer-lag.md"],
			fallbackBySeverity,
			alwaysSelect,
		});
		expect(verdict).not.toBeNull();
		expect(verdict?.score).toBe(0);
		expect(verdict?.missing).toEqual(["code-change-correlation.md"]);
	});

	test("a superset of always_select still scores 1 (extra runbooks are not a defect)", () => {
		const verdict = compareRunbookSelection({
			severity: "critical",
			selectedRunbooks: ["kafka-consumer-lag.md", "high-error-rate.md", "code-change-correlation.md"],
			fallbackBySeverity,
			alwaysSelect,
		});
		expect(verdict?.score).toBe(1);
	});

	// selectedRunbooks is state.ts's tri-state: null means the selector node never ran this
	// turn (e.g. a simple/non-complex turn) -- there is no selection decision to grade, so this
	// must emit no verdict rather than a false failure.
	test("selectedRunbooks === null (selector did not run) yields no verdict", () => {
		const verdict = compareRunbookSelection({
			severity: "critical",
			selectedRunbooks: null,
			fallbackBySeverity,
			alwaysSelect,
		});
		expect(verdict).toBeNull();
	});

	test("an empty selection when always_select is empty scores 1, not a false failure", () => {
		const verdict = compareRunbookSelection({
			severity: "low",
			selectedRunbooks: [],
			fallbackBySeverity,
			alwaysSelect: [],
		});
		expect(verdict?.score).toBe(1);
	});

	test("missing severity yields no verdict (cannot compare against an unknown fallback tier)", () => {
		const verdict = compareRunbookSelection({
			severity: undefined,
			selectedRunbooks: ["code-change-correlation.md"],
			fallbackBySeverity,
			alwaysSelect,
		});
		expect(verdict).toBeNull();
	});
});
