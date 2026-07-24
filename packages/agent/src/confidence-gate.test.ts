// agent/src/confidence-gate.test.ts
// SIO-1194: deriveConfidenceCap is the single threshold-derived cap used by the
// aggregator, the correlation enforce node, and the validator, so a manifest
// threshold below 0.6 can never make a capped run read as passing the HITL gate.
import { describe, expect, test } from "bun:test";
import { deriveConfidenceCap } from "./confidence-gate.ts";

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
