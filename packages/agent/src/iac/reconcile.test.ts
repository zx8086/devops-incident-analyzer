// agent/src/iac/reconcile.test.ts
// SIO-1005: the proposed -> applied/failed reconciliation core. The pure decision/annotation
// builders are tested directly; reconcileOne/reconcileAll/enumerate are exercised with mocked
// nodes.fetchMrLiveState + memory-backend + memory-writer so no MCP/REST is touched.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// --- mock seams (complete stubs; re-asserted in beforeEach to survive sibling mock pollution) ---
type LiveState = {
	mrState: string;
	mergeCommitSha?: string;
	applyStatus: string;
	applyPipelineId: number | null;
	applyPipelineUrl: string;
};
const liveByIid = new Map<number, LiveState>();
const recordedDecisions: Array<{ decision: string; annotations?: Record<string, string> }> = [];
const dailyLogs: Array<{ summary?: string }> = [];
let searchHits: Array<{ text: string; annotations: Record<string, string> }> = [];
let backend = "agent-memory";

mock.module("./nodes.ts", () => ({
	fetchMrLiveState: async (iid: number): Promise<LiveState> =>
		liveByIid.get(iid) ?? { mrState: "", applyStatus: "", applyPipelineId: null, applyPipelineUrl: "" },
}));

mock.module("../memory-backend.ts", () => ({
	selectedBackend: () => backend,
	searchAgentMemory: async () => searchHits,
	// real dedupeHitsBy semantics: first-hit-wins, keyless never collapse
	dedupeHitsBy: <T extends { annotations: Record<string, string> }>(
		hits: T[],
		keyFn: (h: T) => string | undefined,
	): T[] => {
		const seen = new Set<string>();
		const out: T[] = [];
		for (const [i, h] of hits.entries()) {
			const key = keyFn(h) ?? `\0nokey:${i}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(h);
		}
		return out;
	},
}));

mock.module("../memory-writer.ts", () => ({
	recordKeyDecision: (d: { decision: string; annotations?: Record<string, string> }) => recordedDecisions.push(d),
	appendDailyLog: (e: { summary?: string }) => dailyLogs.push(e),
}));

import {
	buildReconciledIacAnnotations,
	buildReconciledIacDecision,
	enumerateUnreconciledChanges,
	iacProposalFactTtlSeconds,
	type ReconcileTarget,
	reconcileAll,
	reconcileOne,
} from "./reconcile.ts";

const target = (over: Partial<ReconcileTarget> = {}): ReconcileTarget => ({
	mrIid: 9,
	mrUrl: "https://gitlab.com/x/-/merge_requests/9",
	configChangeId: "req-1",
	deployment: "eu-cld",
	stack: "lifecycle-policies",
	stackInstance: "eu-cld/lifecycle-policies",
	changeSummary: "[eu-cld] logs: hot max_age=14d",
	workflow: "ilm-rollout",
	...over,
});

beforeEach(() => {
	liveByIid.clear();
	recordedDecisions.length = 0;
	dailyLogs.length = 0;
	searchHits = [];
	backend = "agent-memory";
});

afterEach(() => {
	mock.restore();
});

describe("buildReconciledIacDecision (SIO-1005)", () => {
	test("applied states the change is live", () => {
		const d = buildReconciledIacDecision(target(), "applied");
		expect(d).toContain("APPLIED (live)");
		expect(d).toContain("eu-cld/lifecycle-policies");
		expect(d).toContain("[eu-cld] logs: hot max_age=14d");
		expect(d.toLowerCase()).not.toContain("proposed");
	});

	test("apply-failed states NOT live", () => {
		const d = buildReconciledIacDecision(target(), "apply-failed");
		expect(d).toContain("APPLY FAILED");
		expect(d).toContain("NOT live");
	});

	test("closed states nothing was applied", () => {
		const d = buildReconciledIacDecision(target(), "closed");
		expect(d).toContain("CLOSED without merging");
		expect(d).toContain("Nothing was applied");
	});
});

describe("buildReconciledIacAnnotations (SIO-1005)", () => {
	test("carries identity keys verbatim + the lifecycle annotation", () => {
		const a = buildReconciledIacAnnotations(target(), "applied", 222, "https://gitlab.com/apply/222");
		expect(a).toMatchObject({
			kind: "iac-change",
			lifecycle: "applied",
			outcome: "applied",
			mr_iid: "9",
			mr_url: "https://gitlab.com/x/-/merge_requests/9",
			config_change_id: "req-1",
			deployment: "eu-cld",
			stack_instance: "eu-cld/lifecycle-policies",
			change_summary: "[eu-cld] logs: hot max_age=14d",
			workflow: "ilm-rollout",
			apply_pipeline_id: "222",
			apply_pipeline_url: "https://gitlab.com/apply/222",
		});
	});
});

describe("reconcileOne (SIO-1005)", () => {
	test("merged + apply success -> records an authoritative applied fact + dailylog", async () => {
		liveByIid.set(9, {
			mrState: "merged",
			mergeCommitSha: "abc",
			applyStatus: "success",
			applyPipelineId: 222,
			applyPipelineUrl: "https://gitlab.com/apply/222",
		});
		const result = await reconcileOne(target());
		expect(result.lifecycle).toBe("applied");
		expect(result.recorded).toBe(true);
		expect(recordedDecisions).toHaveLength(1);
		expect(recordedDecisions[0]?.annotations?.lifecycle).toBe("applied");
		expect(dailyLogs).toHaveLength(1);
		expect(dailyLogs[0]?.summary).toContain("applied");
	});

	test("merged + apply failed -> records apply-failed", async () => {
		liveByIid.set(9, {
			mrState: "merged",
			mergeCommitSha: "abc",
			applyStatus: "failed",
			applyPipelineId: 222,
			applyPipelineUrl: "",
		});
		const result = await reconcileOne(target());
		expect(result.lifecycle).toBe("apply-failed");
		expect(result.recorded).toBe(true);
		expect(recordedDecisions[0]?.annotations?.lifecycle).toBe("apply-failed");
	});

	test("still open -> NO fact written (re-checked next sweep)", async () => {
		liveByIid.set(9, { mrState: "opened", applyStatus: "", applyPipelineId: null, applyPipelineUrl: "" });
		const result = await reconcileOne(target());
		expect(result.lifecycle).toBe("open");
		expect(result.recorded).toBe(false);
		expect(recordedDecisions).toHaveLength(0);
		expect(dailyLogs).toHaveLength(0);
	});

	test("merged but apply still running -> NO fact (transient, not terminal)", async () => {
		liveByIid.set(9, {
			mrState: "merged",
			mergeCommitSha: "abc",
			applyStatus: "running",
			applyPipelineId: 222,
			applyPipelineUrl: "",
		});
		const result = await reconcileOne(target());
		expect(result.lifecycle).toBe("apply-running");
		expect(result.recorded).toBe(false);
		expect(recordedDecisions).toHaveLength(0);
	});
});

describe("enumerateUnreconciledChanges (SIO-1005)", () => {
	test("skips facts already terminal-reconciled, keeps proposals with an mr_iid", async () => {
		searchHits = [
			{ text: "proposed A", annotations: { mr_url: "uA", mr_iid: "10", config_change_id: "rA" } },
			{ text: "applied B", annotations: { mr_url: "uB", mr_iid: "11", lifecycle: "applied" } },
			{ text: "proposal no iid", annotations: { mr_url: "uC", config_change_id: "rC" } },
		];
		const targets = await enumerateUnreconciledChanges();
		expect(targets.map((t) => t.mrIid)).toEqual([10]); // B is terminal, C has no iid
	});

	test("empty when backend is not agent-memory", async () => {
		backend = "file";
		searchHits = [{ text: "x", annotations: { mr_iid: "10" } }];
		expect(await enumerateUnreconciledChanges()).toEqual([]);
	});
});

describe("reconcileAll (SIO-1005)", () => {
	test("summarizes a sweep: one applied advance, one still-open skip", async () => {
		searchHits = [
			{ text: "proposed A", annotations: { mr_url: "uA", mr_iid: "10", config_change_id: "rA" } },
			{ text: "proposed B", annotations: { mr_url: "uB", mr_iid: "11", config_change_id: "rB" } },
		];
		liveByIid.set(10, {
			mrState: "merged",
			mergeCommitSha: "a",
			applyStatus: "success",
			applyPipelineId: 1,
			applyPipelineUrl: "",
		});
		liveByIid.set(11, { mrState: "opened", applyStatus: "", applyPipelineId: null, applyPipelineUrl: "" });
		const summary = await reconcileAll({ source: "cron" });
		expect(summary).toMatchObject({ source: "cron", checked: 2, advanced: 1, applied: 1, stillOpen: 1, errors: 0 });
		expect(recordedDecisions).toHaveLength(1);
	});

	test("no-op summary when backend is not agent-memory", async () => {
		backend = "file";
		const summary = await reconcileAll({ source: "bootstrap" });
		expect(summary).toMatchObject({ checked: 0, advanced: 0 });
	});
});

describe("iacProposalFactTtlSeconds (SIO-1005)", () => {
	// TTL is now driven by the agent-memory backend (the `backend` mock var), not a separate flag.
	const prevTtl = process.env.IAC_PROPOSAL_FACT_TTL_SECONDS;
	afterEach(() => {
		if (prevTtl === undefined) delete process.env.IAC_PROPOSAL_FACT_TTL_SECONDS;
		else process.env.IAC_PROPOSAL_FACT_TTL_SECONDS = prevTtl;
	});

	test("backend NOT agent-memory -> undefined (proposal stays durable; never expire without a reconciler)", () => {
		backend = "file";
		expect(iacProposalFactTtlSeconds()).toBeUndefined();
	});

	test("agent-memory, no override -> 90-day default", () => {
		backend = "agent-memory";
		delete process.env.IAC_PROPOSAL_FACT_TTL_SECONDS;
		expect(iacProposalFactTtlSeconds()).toBe(7_776_000);
	});

	test("agent-memory, valid override -> that value", () => {
		backend = "agent-memory";
		process.env.IAC_PROPOSAL_FACT_TTL_SECONDS = "2592000"; // 30d
		expect(iacProposalFactTtlSeconds()).toBe(2_592_000);
	});

	test("agent-memory, invalid override -> falls back to the default", () => {
		backend = "agent-memory";
		process.env.IAC_PROPOSAL_FACT_TTL_SECONDS = "not-a-number";
		expect(iacProposalFactTtlSeconds()).toBe(7_776_000);
	});
});
