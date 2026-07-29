// agent/src/confidence-gate.test.ts
// SIO-1194: deriveConfidenceCap is the single threshold-derived cap used by the
// aggregator, the correlation enforce node, and the validator, so a manifest
// threshold below 0.6 can never make a capped run read as passing the HITL gate.
import { describe, expect, test } from "bun:test";
import { checkConfidence, deriveConfidenceCap, getConfidenceThreshold } from "./confidence-gate.ts";
import type { AgentStateType } from "./state.ts";

describe("deriveConfidenceCap (SIO-1194)", () => {
	test("returns 0.59 at the default 0.6 threshold", () => {
		expect(deriveConfidenceCap(0.6)).toBe(0.59);
	});

	test("stays strictly below a lower manifest threshold", () => {
		expect(deriveConfidenceCap(0.5)).toBeCloseTo(0.49, 10);
		expect(deriveConfidenceCap(0.5)).toBeLessThan(0.5);
	});

	test("never exceeds 0.59 even for higher thresholds", () => {
		expect(deriveConfidenceCap(0.75)).toBe(0.59);
		expect(deriveConfidenceCap(0.9)).toBe(0.59);
	});

	test("never goes negative for a pathological sub-0.01 threshold (CodeRabbit PR #455)", () => {
		expect(deriveConfidenceCap(0.005)).toBe(0);
		expect(deriveConfidenceCap(0)).toBe(0);
	});
});

// SIO-1273: the gate carried `if (score > 0 && score < threshold)`. Because 0 is ALSO what an
// absent confidence line extracts to, the least trustworthy report -- one that never stated a
// confidence at all -- fell through to "Confidence check passed". Run eaebc62b shipped
// `confidence: 0` alongside `lowConfidence: false` for exactly that reason.
describe("checkConfidence treats an unmeasured report as low confidence (SIO-1273)", () => {
	const stateWith = (confidenceScore: number) => ({ confidenceScore }) as unknown as AgentStateType;
	const threshold = getConfidenceThreshold();

	test("a score of 0 now flags low confidence", () => {
		expect(checkConfidence(stateWith(0))).toEqual({ lowConfidence: true });
	});

	test("a normal sub-threshold score still flags (non-regression)", () => {
		expect(checkConfidence(stateWith(0.59))).toEqual({ lowConfidence: true });
	});

	test("a score at or above the threshold still passes (non-regression)", () => {
		expect(checkConfidence(stateWith(threshold))).toEqual({ lowConfidence: false });
		expect(checkConfidence(stateWith(0.95))).toEqual({ lowConfidence: false });
	});

	// Anti-vacuity: the assertions above are only meaningful if 0 really is below the threshold.
	test("the threshold is above 0, so the 0 case is genuinely sub-threshold", () => {
		expect(threshold).toBeGreaterThan(0);
	});
});
