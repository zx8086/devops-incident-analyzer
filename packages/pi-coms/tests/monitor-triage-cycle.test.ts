// tests/monitor-triage-cycle.test.ts
// SIO-1883: report-only families and the turn / held-back counts. The judge is
// injected; runCycle never reaches the network.
import { describe, expect, test } from "bun:test";
import { type CycleDeps, envFamilies, runCycle, triageCounts } from "../scripts/coms-net-monitor.ts";
import { type Finding, formatDigest } from "../scripts/monitor/report.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const W = (key: string, over: Partial<Finding> = {}): Finding => ({
	family: "logs",
	severity: "warn",
	resource: `/aws/lambda/${key}`,
	summary: `${key} errors`,
	dedup_key: `logs:${key}`,
	evidence: {},
	at: new Date().toISOString(),
	...over,
});

function harness(
	findings: Finding[],
	over: Partial<CycleDeps> = {},
): CycleDeps & { sent: string[]; batches: string[][] } {
	const sent: string[] = [];
	const batches: string[][] = [];
	return {
		sent,
		batches,
		checks: [{ name: "c", run: async () => findings }],
		state: new MonitorState(":memory:"),
		investigate: async (batch) => {
			batches.push(batch.map((f) => f.dedup_key));
			return { diagnoses: null, failure: null };
		},
		report: async (t) => {
			sent.push(t);
		},
		log: () => {},
		...over,
	};
}

describe("report-only families (SIO-1883)", () => {
	test("a warn in a report-only family is reported, not investigated; a critical one still is", async () => {
		const d = harness(
			[
				W("bill", { family: "compliance", dedup_key: "compliance:bill" }),
				W("spike", { family: "compliance", severity: "critical", dedup_key: "compliance:spike" }),
				W("app"),
			],
			{ reportOnlyFamilies: new Set(["compliance"]) },
		);
		await runCycle(d);
		expect(d.batches).toEqual([["compliance:spike", "logs:app"]]);
		expect(d.sent[0]).toContain("uninvestigated: report-only family (compliance)");
	});

	test("a batch of only report-only warns spends no turn", async () => {
		const d = harness([W("bill", { family: "compliance", dedup_key: "compliance:bill" })], {
			reportOnlyFamilies: new Set(["compliance"]),
		});
		await runCycle(d);
		expect(d.batches).toEqual([]);
		expect(d.sent).toHaveLength(1);
	});

	test("report-only findings never reach the jev gate either", async () => {
		// Nothing leaves the host for a finding that was never going to be investigated.
		const judged: string[][] = [];
		const d = harness([W("bill", { family: "compliance", dedup_key: "compliance:bill" }), W("app")], {
			reportOnlyFamilies: new Set(["compliance"]),
			actionability: {
				enforcing: true,
				judge: async (batch) => {
					judged.push(batch.map((f) => f.dedup_key));
					return new Map();
				},
			},
		});
		await runCycle(d);
		expect(judged).toEqual([["logs:app"]]);
	});

	test("envFamilies trims, drops empties, and is empty when unset", () => {
		expect([...envFamilies(" compliance, drift ,,")]).toEqual(["compliance", "drift"]);
		expect(envFamilies(undefined).size).toBe(0);
	});
});

describe("triage counts (SIO-1883)", () => {
	test("counts turns and only ENFORCED held-back verdicts", () => {
		const state = new MonitorState(":memory:");
		state.journal("investigation", {
			resources: ["r"],
			dedup_keys: ["k"],
			count: 1,
			target: "t",
			outcome: "diagnosed",
		});
		state.journal("investigation", { resources: ["r"], dedup_keys: ["k"], count: 1, target: "t", outcome: "refused" });
		state.journal("actionability_verdict", { enforced: true, reason: "routine operational event (p=0.9)" });
		state.journal("actionability_verdict", { enforced: false, reason: "routine operational event (p=0.9)" });
		expect(triageCounts(state, 60_000)).toEqual({ turns: 1, heldBack: 1 });
	});

	test("the digest names turns and holds, and omits the line on a quiet day", () => {
		const base = {
			accountId: "123456789012",
			since: "2026-09-26T00:00:00.000Z",
			findingCounts: {},
			checkErrors: 0,
			activeAlarms: [],
			yesterdayUsd: null,
			baselineUsd: null,
		};
		expect(formatDigest({ ...base, triage: { turns: 0, heldBack: 0 } })).not.toContain("- investigation:");
		expect(formatDigest({ ...base, triage: { turns: 7, heldBack: 3 } })).toContain(
			"- investigation: 7 turn(s), 3 finding(s) held back by the jev gate",
		);
	});
});
