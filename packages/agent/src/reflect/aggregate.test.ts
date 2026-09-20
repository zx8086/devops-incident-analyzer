// packages/agent/src/reflect/aggregate.test.ts
//
// SIO-1834 (A4): the aggregation, anchor and gate checks from the handover's section 13.
import { describe, expect, test } from "bun:test";
import { aggregate, MIN_RECURRENCE } from "./aggregate.ts";
import { findRetries, overlap, shingles } from "./anchors.ts";
import { lintAnalysis } from "./check-analysis.ts";
import { renderMarkdown } from "./report.ts";
import type { Scan, Severity, SignalKind } from "./schema.ts";

function scan(
	id: string,
	signals: Array<{ kind: SignalKind; severity?: Severity; suspects?: string[]; count?: number }>,
	extra: { userMessages?: number; created?: string; request?: string; headless?: boolean } = {},
): Scan {
	return {
		source: {
			host: "langsmith",
			id,
			threadId: null,
			created: extra.created ?? "2026-09-20T10:00:00.000Z",
			headless: extra.headless ?? false,
			datasources: [],
		},
		request: extra.request ? { message: 0, created: extra.created ?? null, text: extra.request } : null,
		stats: {
			messages: 2,
			userMessages: extra.userMessages ?? 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			toolFailures: 0,
			expectedOutcomes: 0,
			environmentFailures: 0,
			repeats: 0,
			corrections: 0,
			reprompts: 0,
			redoRequests: 0,
			handoffs: 0,
		},
		signals: signals.map((s, i) => ({
			id: `S${i + 1}`,
			kind: s.kind,
			severity: s.severity ?? "medium",
			summary: `${s.kind} summary`,
			count: s.count ?? 1,
			suspects: s.suspects ?? [],
			evidence: [{ message: 1, tool: "t", excerpt: "e" }],
		})),
		notes: [],
	};
}

describe("aggregate", () => {
	test("a gap in one session only is not a finding", () => {
		const analysis = aggregate([scan("s1", [{ kind: "tool-failure", suspects: ["elastic"] }])], { hours: 168 });
		expect(analysis.findings).toEqual([]);
		expect(MIN_RECURRENCE).toBe(2);
	});

	test("the same gap in 3 sessions is one finding with recurrence 3", () => {
		const analysis = aggregate(
			["s1", "s2", "s3"].map((id) => scan(id, [{ kind: "tool-failure", suspects: ["elastic"] }])),
			{ hours: 168 },
		);
		expect(analysis.findings.length).toBe(1);
		expect(analysis.findings[0]).toMatchObject({ id: "F1", recurrence: 3, datasource: "elastic" });
		expect(analysis.findings[0]?.sessions).toEqual(["s1", "s2", "s3"]);
	});

	// Recurrence outranks volume: one session failing 10x is still one session.
	test("recurrence outranks raw count", () => {
		const analysis = aggregate(
			[
				scan("s1", [{ kind: "tool-failure", suspects: ["aws"], count: 50 }]),
				scan("s2", [{ kind: "repeat-call", suspects: ["gitlab"], count: 1 }]),
				scan("s3", [{ kind: "repeat-call", suspects: ["gitlab"], count: 1 }]),
				scan("s4", [{ kind: "repeat-call", suspects: ["gitlab"], count: 1 }]),
			],
			{ hours: 168 },
		);
		expect(analysis.findings[0]?.datasource).toBe("gitlab");
		expect(analysis.findings[0]?.recurrence).toBe(3);
		// aws appeared once, so it never becomes a finding despite 50 occurrences.
		expect(analysis.findings.some((f) => f.datasource === "aws")).toBe(false);
	});

	test("group severity is the max seen, not the first", () => {
		const analysis = aggregate(
			[
				scan("s1", [{ kind: "tool-failure", suspects: ["aws"], severity: "low" }]),
				scan("s2", [{ kind: "tool-failure", suspects: ["aws"], severity: "high" }]),
			],
			{ hours: 168 },
		);
		expect(analysis.findings[0]?.severity).toBe("high");
	});

	// Evidence exists to let a reader CHECK the recurrence. Three quotes from one run prove
	// nothing the count did not already claim (seen on a real report: 12 sessions, evidence
	// from 1).
	test("evidence spans distinct sessions, one per session", () => {
		const analysis = aggregate(
			["s1", "s2", "s3", "s4"].map((id) => scan(id, [{ kind: "tool-failure", suspects: ["aws"], count: 5 }])),
			{ hours: 168 },
		);
		const evidence = analysis.findings[0]?.evidence ?? [];
		expect(evidence.length).toBe(3);
		expect(new Set(evidence.map((e) => e.session)).size).toBe(3);
	});

	// Greptile P1 (PR #862): a user reaction implicates the TURN, not a datasource. Taking
	// suspects[0] pointed remediation at whichever datasource sorted first.
	test("a signal with several suspects owns nothing, rather than owning the first", () => {
		const analysis = aggregate(
			["s1", "s2"].map((id) => scan(id, [{ kind: "user-redo", suspects: ["aws", "elastic"], severity: "high" }])),
			{ hours: 168 },
		);
		expect(analysis.findings[0]?.datasource).toBeNull();
		// and it is NOT mistaken for a create candidate: that rule is tool-failure only
		expect(analysis.portfolio).toEqual([]);
	});

	test("a single suspect still owns the finding", () => {
		const analysis = aggregate(
			["s1", "s2"].map((id) => scan(id, [{ kind: "tool-failure", suspects: ["elastic"] }])),
			{ hours: 168 },
		);
		expect(analysis.findings[0]?.datasource).toBe("elastic");
	});

	test("expected-outcome is never a finding", () => {
		const analysis = aggregate(
			["s1", "s2", "s3"].map((id) => scan(id, [{ kind: "expected-outcome" }])),
			{ hours: 168 },
		);
		expect(analysis.findings).toEqual([]);
	});

	test("a recurring failure owned by no datasource is a create candidate", () => {
		const analysis = aggregate(
			["s1", "s2"].map((id) => scan(id, [{ kind: "tool-failure", suspects: [] }])),
			{ hours: 168 },
		);
		expect(analysis.portfolio.length).toBe(1);
		expect(analysis.portfolio[0]).toMatchObject({ id: "PF1", action: "create", recurrence: 2 });
	});

	test("a recurring failure that names a datasource is NOT a create candidate", () => {
		const analysis = aggregate(
			["s1", "s2"].map((id) => scan(id, [{ kind: "tool-failure", suspects: ["kafka"] }])),
			{ hours: 168 },
		);
		expect(analysis.portfolio).toEqual([]);
		expect(analysis.findings.length).toBe(1);
	});

	// The blind spot must be stated, or an empty quality lane reads as "no problems".
	test("a single-turn window records the starved quality lane as a note", () => {
		const analysis = aggregate([scan("s1", [], { userMessages: 1 })], { hours: 168 });
		expect(analysis.stats.multiTurnSessions).toBe(0);
		expect(analysis.notes.join(" ")).toContain("no user-reaction detector could fire");
	});

	test("a multi-turn window adds no such note", () => {
		const analysis = aggregate([scan("s1", [], { userMessages: 3 })], { hours: 168 });
		expect(analysis.stats.multiTurnSessions).toBe(1);
		expect(analysis.notes).toEqual([]);
	});
});

describe("anchors", () => {
	test("overlap is measured against the shorter text", () => {
		const a = shingles("restart the checkout service in production");
		const b = shingles("restart the checkout service in production and tell me why it failed");
		expect(overlap(a, b)).toBeGreaterThan(0.9);
		expect(overlap(shingles(""), b)).toBe(0);
	});

	test("two sessions with the same request an hour apart is a retry", () => {
		const text = "why did the checkout service start returning five hundreds this morning";
		const retries = findRetries([
			scan("early", [], { created: "2026-09-20T10:00:00.000Z", request: text }),
			scan("late", [], { created: "2026-09-20T11:00:00.000Z", request: text }),
		]);
		expect(retries.length).toBe(1);
		expect(retries[0]).toMatchObject({ earlier: "early", later: "late", hours: 1 });
	});

	test("the same request beyond the 48h window is not a retry", () => {
		const text = "why did the checkout service start returning five hundreds this morning";
		const retries = findRetries([
			scan("early", [], { created: "2026-09-18T10:00:00.000Z", request: text }),
			scan("late", [], { created: "2026-09-20T12:00:00.000Z", request: text }),
		]);
		expect(retries).toEqual([]);
	});

	test("an opener repeated across 3+ sessions is a template, not a retry", () => {
		const text = "run the scheduled health probe across every production estate and report";
		const retries = findRetries(
			["a", "b", "c"].map((id, i) => scan(id, [], { created: `2026-09-20T1${i}:00:00.000Z`, request: text })),
		);
		expect(retries).toEqual([]);
	});

	test("headless runs never produce retries", () => {
		const text = "why did the checkout service start returning five hundreds this morning";
		const retries = findRetries([
			scan("e", [], { created: "2026-09-20T10:00:00.000Z", request: text, headless: true }),
			scan("l", [], { created: "2026-09-20T11:00:00.000Z", request: text, headless: true }),
		]);
		expect(retries).toEqual([]);
	});
});

describe("check-analysis", () => {
	const clean = () =>
		aggregate(
			["s1", "s2"].map((id) => scan(id, [{ kind: "tool-failure", suspects: ["aws"] }], { userMessages: 2 })),
			{ hours: 168 },
		);

	test("a well-formed report passes", () => {
		expect(lintAnalysis(clean())).toEqual([]);
	});

	test("an empty window fails with no-evidence", () => {
		const violations = lintAnalysis(aggregate([], { hours: 168 }));
		expect(violations.map((v) => v.rule)).toContain("no-evidence");
	});

	test("a finding below the recurrence bar is caught", () => {
		const analysis = clean();
		analysis.findings[0] = { ...analysis.findings[0], recurrence: 1, sessions: ["s1"] } as never;
		expect(lintAnalysis(analysis).map((v) => v.rule)).toContain("finding-recurrence");
	});

	test("a finding with no evidence is caught", () => {
		const analysis = clean();
		analysis.findings[0] = { ...analysis.findings[0], evidence: [] } as never;
		expect(lintAnalysis(analysis).map((v) => v.rule)).toContain("finding-evidence");
	});

	test("evidence citing a run outside the finding's own sessions is caught", () => {
		const analysis = clean();
		analysis.findings[0] = {
			...analysis.findings[0],
			evidence: [{ session: "not-mine", message: 1, tool: null, excerpt: "e" }],
		} as never;
		expect(lintAnalysis(analysis).map((v) => v.rule)).toContain("finding-evidence-session");
	});

	test("stats that disagree with the arrays are caught", () => {
		const analysis = clean();
		analysis.stats.findings = 99;
		expect(lintAnalysis(analysis).map((v) => v.rule)).toContain("stats-drift");
	});

	test("a starved quality lane that is NOT stated is caught", () => {
		const analysis = aggregate([scan("s1", [{ kind: "tool-failure", suspects: ["aws"] }], { userMessages: 1 })], {
			hours: 168,
		});
		analysis.notes = [];
		expect(lintAnalysis(analysis).map((v) => v.rule)).toContain("unstated-blind-spot");
	});

	test("garbage fails the schema rather than throwing", () => {
		expect(lintAnalysis({ nonsense: true }).map((v) => v.rule)).toEqual(["bad-schema"]);
	});
});

describe("report", () => {
	test("markdown carries the findings, the blind-spot note and the verify reminder", () => {
		const analysis = aggregate(
			["s1", "s2"].map((id) => scan(id, [{ kind: "tool-failure", suspects: ["elastic"], severity: "high" }])),
			{ hours: 168 },
		);
		const md = renderMarkdown(analysis);
		expect(md).toContain("# Skill reflection report");
		expect(md).toContain("F1");
		expect(md).toContain("elastic");
		expect(md).toContain("Datasources in use");
		// The starved-lane warning must appear before the findings a reader would act on.
		expect(md.indexOf("Read this first")).toBeLessThan(md.indexOf("## Findings"));
		expect(md).toContain("lead, not a verdict");
	});

	// Greptile P2 (PR #862): an excerpt is verbatim tool output, so it must READ as its
	// literal characters. Left raw, a backtick closes the code span around it and
	// [x](url) renders as a live link in a document a human is meant to trust.
	test("evidence renders as literal text, not as active Markdown", () => {
		const analysis = aggregate(
			["s1", "s2"].map((id) => scan(id, [{ kind: "tool-failure", suspects: ["aws"] }])),
			{ hours: 168 },
		);
		analysis.findings[0] = {
			...analysis.findings[0],
			evidence: [{ session: "s1", message: 1, tool: "t", excerpt: "use `x` and [docs](http://evil) and _em_" }],
		} as never;
		const md = renderMarkdown(analysis);
		const line = md.split("\n").find((l) => l.includes("evil")) ?? "";
		// The excerpt keeps its characters but loses its power: it is wrapped in a code
		// fence longer than any backtick run inside it, so the single backticks around `x`
		// cannot close the span and the link renders as text.
		const excerpt = line.slice(line.indexOf("): ") + 3);
		expect(excerpt.startsWith("``")).toBe(true);
		expect(excerpt.endsWith("``")).toBe(true);
		expect(excerpt).toContain("[docs](http://evil)");
	});

	test("an empty window still renders a report that says so", () => {
		const md = renderMarkdown(aggregate([], { hours: 24 }));
		expect(md).toContain("0 sessions");
		expect(md).toContain("No gap recurred");
	});
});
