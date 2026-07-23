// packages/shared/src/__tests__/confidence.test.ts
// SIO-1194: shared cap-reason vocabulary consumed by both the agent's confidence
// line annotation and the web ConfidenceBadge, so prose and UI always agree.
import { describe, expect, test } from "bun:test";
import { CAP_REASON_INFO, capReasonDetail, capReasonLabel } from "../confidence.ts";

describe("CAP_REASON_INFO", () => {
	test("covers every deterministic cap trigger code", () => {
		const expectedCodes = [
			"degraded-subagents",
			"gaps",
			"ungrounded-blocker",
			"ungrounded-expiry",
			"premature-absence",
			"ungrounded-root-cause",
			"no-index-misread",
			"correlation-degraded",
			"ungrounded-metrics",
		];
		expect(Object.keys(CAP_REASON_INFO).sort()).toEqual([...expectedCodes].sort());
	});

	test("every entry has a non-empty label and detail", () => {
		for (const [code, info] of Object.entries(CAP_REASON_INFO)) {
			expect(info.label.length, `label for ${code}`).toBeGreaterThan(0);
			expect(info.detail.length, `detail for ${code}`).toBeGreaterThan(0);
		}
	});

	test("labels never start with a digit (LOOSE_CONFIDENCE_RE safety: the annotation must not put a number within 20 chars of the word confidence)", () => {
		for (const info of Object.values(CAP_REASON_INFO)) {
			expect(info.label).not.toMatch(/^\d/);
		}
	});
});

describe("capReasonLabel / capReasonDetail", () => {
	test("returns the mapped label for a known code", () => {
		expect(capReasonLabel("degraded-subagents")).toBe("datasource tool errors");
	});

	test("falls back to the raw code for unknown reasons", () => {
		expect(capReasonLabel("future-new-cap")).toBe("future-new-cap");
		expect(capReasonDetail("future-new-cap")).toBe("future-new-cap");
	});

	test("returns the mapped detail for a known code", () => {
		expect(capReasonDetail("gaps")).toContain("gaps");
	});
});
