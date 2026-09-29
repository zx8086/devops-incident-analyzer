// packages/pi-coms/tests/monitor-harvest.test.ts

// SIO-1892: journal diagnoses -> redacted candidate drafts. Built from a real
// MonitorState journal, so the row shapes are the ones the monitor writes.
import { describe, expect, test } from "bun:test";
import { monitorName, parseHarvestArgs } from "../scripts/fleet-harvest.ts";
import {
	groupDiagnoses,
	harvest,
	harvestJournal,
	originId,
	selectGroups,
	slug,
	toCandidateDraft,
} from "../scripts/monitor/harvest.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "444455556666";

function finding(dedupKey: string, extra: Record<string, unknown> = {}) {
	return {
		family: "rds",
		severity: "warn",
		resource: `arn:aws:rds:eu-west-1:${ACCOUNT_A}:db:orders`,
		summary: `FreeStorageSpace under 2 GiB on orders in ${ACCOUNT_A}`,
		dedup_key: dedupKey,
		evidence: { metric: "FreeStorageSpace" },
		at: "2026-09-28T10:00:00.000Z",
		diagnosis: {
			probable_cause: `Storage nearly full on orders after the nightly load in account ${ACCOUNT_A}`,
			affected_resources: ["orders"],
			suggested_action: "Enable storage autoscaling, then purge the audit table",
			evidence: [
				{
					command: "aws rds describe-db-instances --db-instance-identifier orders",
					observation: "AllocatedStorage 100, autoscaling off",
				},
				{ command: "aws cloudwatch get-metric-statistics FreeStorageSpace", observation: "1.4 GiB and falling" },
			],
			confidence: 0.8,
		},
		...extra,
	};
}

function journalFor(account: string, findings: Record<string, unknown>[], verdicts: Record<string, unknown>[] = []) {
	const state = new MonitorState(":memory:");
	// The monitor's order: verdicts during triage, finding rows after investigation.
	for (const v of verdicts) state.journal("actionability_verdict", v);
	for (const f of findings) state.journal("finding", f);
	const rows = state.journalRows(24 * 60 * 60 * 1000);
	state.close();
	return { rows, origin: { account, agent: "aws-spoke" } };
}

describe("harvestJournal", () => {
	test("keeps only spoke-authored diagnoses and joins the verdicts", () => {
		const { rows, origin } = journalFor(
			ACCOUNT_A,
			[
				finding("rds:orders:1"),
				finding("rds:orders:2", { reused_from: "2026-09-27T10:00:00.000Z" }),
				{ family: "alarm", dedup_key: "x", diagnosis: null },
			],
			[
				{
					dedup_key: "rds:orders:1",
					family: "rds",
					severity: "warn",
					resource: "r",
					reason: "routine",
					enforced: true,
				},
			],
		);
		const out = harvestJournal(rows, origin);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			dedupKey: "rds:orders:1",
			confidence: 0.8,
			skippedReason: "routine",
			origin: originId(origin),
		});
		expect(out[0]?.evidence).toHaveLength(2);
	});
});

describe("verdict join and origin (Greptile PR #920)", () => {
	test("a verdict counts only for the finding of its own cycle", () => {
		const origin = { account: ACCOUNT_A, agent: "aws-spoke" };
		const verdict = (ts: string) => ({
			ts,
			kind: "actionability_verdict",
			payload: JSON.stringify({
				dedup_key: "k",
				family: "rds",
				severity: "warn",
				resource: "r",
				reason: "routine",
				enforced: true,
			}),
		});
		const findingRow = (ts: string) => ({ ts, kind: "finding", payload: JSON.stringify(finding("k")) });
		// verdict at 10:00, finding investigated at 10:05: skipped
		const same = harvestJournal([verdict("2026-09-28T10:00:00.000Z"), findingRow("2026-09-28T10:05:00.000Z")], origin);
		expect(same[0]?.skippedReason).toBe("routine");
		// verdict from a cycle three hours earlier: a fresh diagnosis is not tainted
		const later = harvestJournal([verdict("2026-09-28T07:00:00.000Z"), findingRow("2026-09-28T10:05:00.000Z")], origin);
		expect(later[0]?.skippedReason).toBeUndefined();
		// verdict written after the finding belongs to a later cycle
		const after = harvestJournal([findingRow("2026-09-28T10:05:00.000Z"), verdict("2026-09-28T10:10:00.000Z")], origin);
		expect(after[0]?.skippedReason).toBeUndefined();
	});

	test("the monitor's fallback peer name never leaks the account id through the origin", () => {
		const id = originId({ account: ACCOUNT_A, agent: `monitor-aws-${ACCOUNT_A}` });
		expect(id).not.toContain(ACCOUNT_A);
		expect(id).toMatch(/^[0-9a-f]{8}\/monitor-aws-\[ACCOUNT_REDACTED\]$/);
	});

	test("the checkpoint is read under the monitor that investigates the agent", () => {
		expect(monitorName("aws-spoke")).toBe("monitor-aws-spoke");
		expect(monitorName("monitor-aws-spoke")).toBe("monitor-aws-spoke");
	});

	test("the draft's advice and evidence come from the members that succeeded", () => {
		const origin = { account: ACCOUNT_A, agent: "aws-spoke" };
		const weak = finding("k1", {
			diagnosis: { ...(finding("x").diagnosis as object), suggested_action: "Reboot it and hope", confidence: 0.3 },
		});
		const strong = finding("k2");
		const { rows } = journalFor(ACCOUNT_A, [
			weak,
			strong,
			finding("k3", { diagnosis: { ...(finding("x").diagnosis as object), confidence: 0.2 } }),
		]);
		const group = groupDiagnoses(harvestJournal(rows, origin))[0];
		if (!group) throw new Error("no group");
		const draft = toCandidateDraft(group);
		expect(draft.task_success).toBe("1");
		expect(draft.body.startsWith("Do: Enable storage autoscaling")).toBe(true);
		expect(draft.body).not.toContain("Do: Reboot");
	});
});

describe("grouping and selection", () => {
	test("the same cause from two spokes groups; numbers in the cause do not split it", () => {
		const a = journalFor(ACCOUNT_A, [finding("rds:orders:1")]);
		const b = journalFor(ACCOUNT_B, [
			finding("rds:orders:9", {
				diagnosis: {
					...(finding("x").diagnosis as object),
					probable_cause: `Storage nearly full on orders after the nightly load in account ${ACCOUNT_B}`,
				},
			}),
		]);
		const groups = groupDiagnoses([...harvestJournal(a.rows, a.origin), ...harvestJournal(b.rows, b.origin)]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.origins).toHaveLength(2);
		expect(selectGroups(groups, { minOrigins: 2, minOccurrences: 3 })).toHaveLength(1);
		expect(selectGroups(groups, { minOrigins: 3, minOccurrences: 3 })).toHaveLength(0);
	});

	test("a single spoke qualifies by recurrence", () => {
		const a = journalFor(ACCOUNT_A, [finding("k1"), finding("k2"), finding("k3")]);
		const groups = groupDiagnoses(harvestJournal(a.rows, a.origin));
		expect(selectGroups(groups, { minOrigins: 2, minOccurrences: 3 })).toHaveLength(1);
	});
});

describe("toCandidateDraft", () => {
	test("emits a redacted runbook draft with provenance and the fleet verdict", () => {
		const a = journalFor(ACCOUNT_A, [finding("rds:orders:1")]);
		const b = journalFor(ACCOUNT_B, [finding("rds:orders:2")]);
		const group = groupDiagnoses([...harvestJournal(a.rows, a.origin), ...harvestJournal(b.rows, b.origin)])[0];
		if (!group) throw new Error("no group");
		const draft = toCandidateDraft(group);
		expect(draft.kind).toBe("runbook");
		expect(draft.source).toBe("fleet");
		expect(draft.status).toBe("candidate");
		expect(draft.target_dir).toBe("agents/incident-analyzer/knowledge/aws/runbooks");
		expect(draft.skill_name).toMatch(/^[a-z0-9-]+$/);
		expect(draft.title.length).toBeLessThanOrEqual(80);
		expect(draft.applicability.startsWith("When ")).toBe(true);
		expect(draft.body).toContain("Do: Enable storage autoscaling");
		expect(draft.body).toContain("Confirm with: aws rds describe-db-instances");
		expect(draft.evidence.length).toBeGreaterThan(0);
		expect(draft.evidence[0]?.ref).toMatch(/^journal:[0-9a-f]{8}\/aws-spoke#/);
		expect(draft.task_success).toBe("1");
		expect(draft.task_success_source).toBe("fleet-verdict");
		const everything = JSON.stringify(draft);
		expect(everything).not.toContain(ACCOUNT_A);
		expect(everything).not.toContain(ACCOUNT_B);
		expect(everything).not.toMatch(/\b\d{12}\b/);
		expect(everything).not.toContain("arn:aws");
		expect(draft.learned_from.startsWith("fleet:")).toBe(true);
	});

	test("a routine-classified or low-confidence diagnosis carries no fleet verdict", () => {
		const a = journalFor(
			ACCOUNT_A,
			[finding("k1"), finding("k2"), finding("k3")],
			["k1", "k2", "k3"].map((k) => ({
				dedup_key: k,
				family: "rds",
				severity: "warn",
				resource: "r",
				reason: "routine",
				enforced: true,
			})),
		);
		const group = groupDiagnoses(harvestJournal(a.rows, a.origin))[0];
		if (!group) throw new Error("no group");
		expect(toCandidateDraft(group).task_success).toBe("");
	});

	test("slug is kebab, bounded, never empty", () => {
		expect(slug("rds", "Storage nearly full!!")).toBe("rds-storage-nearly-full");
		expect(slug("", "")).toBe("fleet-lesson");
		expect(slug("alarm", "x".repeat(200)).length).toBeLessThanOrEqual(60);
	});
});

describe("harvest (end to end) and args", () => {
	test("two spokes with the same cause yield one candidate", () => {
		const out = harvest(
			[journalFor(ACCOUNT_A, [finding("rds:orders:1")]), journalFor(ACCOUNT_B, [finding("rds:orders:2")])],
			{ windowDays: 14, thresholds: { minOrigins: 2, minOccurrences: 3 }, now: () => "2026-09-29T00:00:00.000Z" },
		);
		expect(out).toMatchObject({ window_days: 14, spokes: 2, generated_at: "2026-09-29T00:00:00.000Z" });
		expect(out.candidates).toHaveLength(1);
	});

	test("parseHarvestArgs pairs --db with --origin and defaults the thresholds", () => {
		const a = parseHarvestArgs(["--db", "x.db", "--origin", `${ACCOUNT_A}/aws-spoke`, "--out", "o.json"]);
		expect(a.dbs).toEqual([{ path: "x.db", account: ACCOUNT_A, agent: "aws-spoke" }]);
		expect(a).toMatchObject({ windowDays: 14, minOrigins: 2, minOccurrences: 3, out: "o.json" });
		expect(() => parseHarvestArgs(["--db", "x.db"])).toThrow("matching --origin");
		expect(() => parseHarvestArgs([])).toThrow("usage");
		const s = parseHarvestArgs([
			"--bundle",
			"s3://b/fleet",
			"--spoke",
			`${ACCOUNT_B}/aws-spoke`,
			"--window-days",
			"30",
		]);
		expect(s.spokes).toEqual([{ account: ACCOUNT_B, agent: "aws-spoke" }]);
		expect(s.windowDays).toBe(30);
	});
});
