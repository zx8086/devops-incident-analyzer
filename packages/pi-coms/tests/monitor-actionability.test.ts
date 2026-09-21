// tests/monitor-actionability.test.ts
// SIO-1838.
import { describe, expect, test } from "bun:test";
import {
	type ActionabilityVerdict,
	planActionability,
	ROUTINE_SKIP_THRESHOLD,
} from "../scripts/monitor/actionability.ts";
import type { Finding } from "../scripts/monitor/report.ts";

function finding(key: string, severity: Finding["severity"] = "warn"): Finding {
	return {
		family: "logs",
		severity,
		resource: `/aws/lambda/${key}`,
		summary: `${key} summary`,
		dedup_key: key,
		evidence: {},
		at: "2026-09-20T10:00:00.000Z",
	};
}

function verdict(routine: number, duplicate = 0): ActionabilityVerdict {
	return { routine, duplicate };
}

describe("planActionability", () => {
	test("shadow mode sends everything while still reporting what it would skip", () => {
		// SIO-1748..1752: an earlier shadow mechanism held real incidents out of the
		// inbox. This one cannot, because in shadow the send list is untouched.
		const f = finding("a");
		const out = planActionability([f], new Map([["a", verdict(0.99)]]), { enforcing: false });
		expect(out.send.map((x) => x.dedup_key)).toEqual(["a"]);
		expect(out.skipped).toEqual([]);
		expect(out.wouldSkip).toHaveLength(1);
		expect(out.wouldSkip[0]?.reason).toContain("routine");
	});

	test("enforcing holds back a confident routine verdict", () => {
		const out = planActionability([finding("a")], new Map([["a", verdict(0.99)]]), { enforcing: true });
		expect(out.send).toEqual([]);
		expect(out.skipped).toHaveLength(1);
		expect(out.skipped[0]?.reason).toContain("p=0.99");
	});

	test("a critical finding is never gated, however confident the verdict", () => {
		// The severity means somebody looks at it. A classifier does not get to
		// overrule that.
		const out = planActionability([finding("a", "critical")], new Map([["a", verdict(1)]]), { enforcing: true });
		expect(out.send.map((x) => x.dedup_key)).toEqual(["a"]);
		expect(out.skipped).toEqual([]);
		expect(out.wouldSkip).toEqual([]);
	});

	test("a finding with no verdict is sent, because a missing judgement is not a skip", () => {
		const out = planActionability([finding("a")], new Map(), { enforcing: true });
		expect(out.send.map((x) => x.dedup_key)).toEqual(["a"]);
		expect(out.skipped).toEqual([]);
	});

	test("the threshold boundary is inclusive, and just below it sends", () => {
		// The boundary IS the gate; an off-by-one here silently drops findings.
		const at = planActionability([finding("a")], new Map([["a", verdict(ROUTINE_SKIP_THRESHOLD)]]), {
			enforcing: true,
		});
		expect(at.skipped).toHaveLength(1);

		const below = planActionability([finding("b")], new Map([["b", verdict(ROUTINE_SKIP_THRESHOLD - 0.01)]]), {
			enforcing: true,
		});
		expect(below.send).toHaveLength(1);
		expect(below.skipped).toEqual([]);
	});

	test("an unconfident verdict sends, which is the common case", () => {
		// A model unsure whether something is routine must not cost an investigation.
		const out = planActionability([finding("a")], new Map([["a", verdict(0.5, 0.5)]]), { enforcing: true });
		expect(out.send).toHaveLength(1);
	});

	test("a confident duplicate verdict is its own reason", () => {
		const out = planActionability([finding("a")], new Map([["a", verdict(0.1, 0.95)]]), { enforcing: true });
		expect(out.skipped[0]?.reason).toContain("recently diagnosed");
	});

	test("mixed batch: only the confident non-critical ones are held", () => {
		const findings = [finding("keep-low"), finding("skip-me"), finding("crit", "critical"), finding("no-verdict")];
		const verdicts = new Map([
			["keep-low", verdict(0.3)],
			["skip-me", verdict(0.97)],
			["crit", verdict(0.99)],
		]);
		const out = planActionability(findings, verdicts, { enforcing: true });
		expect(out.send.map((f) => f.dedup_key)).toEqual(["keep-low", "crit", "no-verdict"]);
		expect(out.skipped.map((s) => s.finding.dedup_key)).toEqual(["skip-me"]);
	});

	test("an empty batch is empty, not an error", () => {
		const out = planActionability([], new Map(), { enforcing: true });
		expect(out).toEqual({ send: [], skipped: [], wouldSkip: [] });
	});
});
