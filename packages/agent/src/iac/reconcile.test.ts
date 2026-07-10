// agent/src/iac/reconcile.test.ts
// SIO-1005: the proposed -> applied/failed reconciliation core. The pure decision/annotation
// builders are tested directly; reconcileOne/reconcileAll/enumerate are exercised with mocked
// mr-live-state.fetchMrLiveState + memory-backend + memory-writer so no MCP/REST is touched.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realKnowledgeGraphNs from "@devops-agent/knowledge-graph";
import * as realMemoryBackendNs from "../memory-backend.ts";
import * as realMemoryWriterNs from "../memory-writer.ts";
import * as realMrLiveStateNs from "./mr-live-state.ts";

// SIO-1045: a namespace import (`import * as ns`) is a LIVE VIEW -- when any file registers a
// mock.module() for this path, bun live-patches every existing namespace binding, INCLUDING these
// captured `real*Ns` objects, so restoring with `() => real*Ns` re-registers the very poison it
// meant to undo (a circular no-op). A value snapshot (spread into a plain object at load time, before
// any mock.module() call below runs) copies the function VALUES and is immune to that later
// live-patching. See SIO-1028 (reference_prompt_context_mock_pollutes_direct_imports) for the same
// class of live-binding bug.
const realMrLiveState = { ...realMrLiveStateNs };
const realMemoryBackend = { ...realMemoryBackendNs };
const realMemoryWriter = { ...realMemoryWriterNs };
// SIO-1053: same value-snapshot discipline for the KG package, which reconcile.ts now imports.
const realKnowledgeGraph = { ...realKnowledgeGraphNs };

// SIO-1045: this file's stub mocks used to be registered at FILE SCOPE, which meant any other test
// file loaded after this one (module graph order, not describe/test order) would statically import an
// already-poisoned ./mr-live-state.ts / ../memory-backend.ts / ../memory-writer.ts before this file's
// afterAll ever ran. Registering them in beforeAll (paired with an afterAll restore, both against the
// value snapshots above) keeps the load phase pristine for every other file's own snapshot.
beforeAll(() => {
	// SIO-1047: fetchMrLiveState moved from nodes.ts to mr-live-state.ts (cycle-break extraction);
	// mock the new home so reconcile.ts's import resolves to this stub.
	mock.module("./mr-live-state.ts", () => ({
		...realMrLiveState,
		fetchMrLiveState: async (iid: number): Promise<LiveState> =>
			liveByIid.get(iid) ?? { mrState: "", applyStatus: "", applyPipelineId: null, applyPipelineUrl: "" },
	}));

	mock.module("../memory-backend.ts", () => ({
		...realMemoryBackend,
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
		...realMemoryWriter,
		recordKeyDecision: (d: { decision: string; annotations?: Record<string, string> }) => recordedDecisions.push(d),
		appendDailyLog: (e: { summary?: string }) => dailyLogs.push(e),
	}));

	// SIO-1053: KG seam. isKnowledgeGraphEnabled/getGraphStore/proposedChangesWithMr/setChangeOutcome
	// are the only KG symbols reconcile.ts calls; stub them so reconcileKnowledgeGraph runs without a
	// real lbug store. setChangeOutcome pushes to kgSetCalls so tests assert the exact (id, outcome).
	mock.module("@devops-agent/knowledge-graph", () => ({
		...realKnowledgeGraph,
		isKnowledgeGraphEnabled: () => kgEnabled,
		getGraphStore: async () => {
			if (kgStoreThrows) throw new Error("store init failed");
			return {} as unknown;
		},
		proposedChangesWithMr: async () => kgProposed,
		setChangeOutcome: async (_store: unknown, id: string, outcome: string) => {
			kgSetCalls.push({ id, outcome });
		},
		// SIO-1062: capture blob-mrUrl repairs so tests assert the exact (id, badUrl, goodUrl).
		repairChangeMrUrl: async (_store: unknown, id: string, badUrl: string, goodUrl: string) => {
			kgRepairCalls.push({ id, badUrl, goodUrl });
		},
	}));
});

// --- mock seams (complete stubs; re-asserted in beforeEach to survive sibling mock pollution) ---
type LiveState = {
	mrState: string;
	mergeCommitSha?: string;
	webUrl?: string; // SIO-1062: for blob-mrUrl repair
	applyStatus: string;
	applyPipelineId: number | null;
	applyPipelineUrl: string;
};
const liveByIid = new Map<number, LiveState>();
const recordedDecisions: Array<{ decision: string; annotations?: Record<string, string> }> = [];
const dailyLogs: Array<{ summary?: string }> = [];
let searchHits: Array<{ text: string; annotations: Record<string, string> }> = [];
let backend = "agent-memory";
// SIO-1053: KG seam state.
let kgEnabled = false;
let kgProposed: Array<{ id: string; mrUrl: string; outcome: string }> = [];
const kgSetCalls: Array<{ id: string; outcome: string }> = [];
// SIO-1062: blob-mrUrl repair captures.
const kgRepairCalls: Array<{ id: string; badUrl: string; goodUrl: string }> = [];
let kgStoreThrows = false;

// SIO-1045: undo the three beforeAll mocks above once this file's tests finish, so a later test
// file in the same process sees the real modules again. Restoring against the value snapshots (not
// the live namespace bindings) is what makes this restore actually take effect on Linux CI.
afterAll(() => {
	mock.module("./mr-live-state.ts", () => realMrLiveState);
	mock.module("../memory-backend.ts", () => realMemoryBackend);
	mock.module("../memory-writer.ts", () => realMemoryWriter);
	mock.module("@devops-agent/knowledge-graph", () => realKnowledgeGraph);
});

import {
	buildReconciledIacAnnotations,
	buildReconciledIacDecision,
	enumerateUnreconciledChanges,
	iacProposalFactTtlSeconds,
	lifecycleToChangeOutcome,
	mrIidFromUrl,
	type ReconcileTarget,
	reconcileAll,
	reconcileEnabled,
	reconcileKnowledgeGraph,
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
	kgEnabled = false;
	kgProposed = [];
	kgSetCalls.length = 0;
	kgRepairCalls.length = 0;
	kgStoreThrows = false;
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

describe("mrIidFromUrl (SIO-1053)", () => {
	test("derives the iid from a GitLab MR url", () => {
		expect(mrIidFromUrl("https://gitlab.com/x/y/-/merge_requests/264")).toBe(264);
	});

	test("null on a url with no merge_requests segment", () => {
		expect(mrIidFromUrl("https://gitlab.com/x/y")).toBeNull();
	});

	test("null on an empty string", () => {
		expect(mrIidFromUrl("")).toBeNull();
	});
});

describe("lifecycleToChangeOutcome (SIO-1053)", () => {
	test("terminal lifecycles map to KG outcomes", () => {
		expect(lifecycleToChangeOutcome("applied")).toBe("applied");
		expect(lifecycleToChangeOutcome("apply-failed")).toBe("failed");
		expect(lifecycleToChangeOutcome("closed")).toBe("rejected");
	});

	test("transient lifecycles map to null (no KG write)", () => {
		expect(lifecycleToChangeOutcome("open")).toBeNull();
		expect(lifecycleToChangeOutcome("apply-running")).toBeNull();
		expect(lifecycleToChangeOutcome("apply-not-started")).toBeNull();
	});
});

describe("reconcileEnabled (SIO-1053)", () => {
	test("true when the agent-memory backend is selected", () => {
		backend = "agent-memory";
		kgEnabled = false;
		expect(reconcileEnabled()).toBe(true);
	});

	test("true when only the knowledge graph is enabled", () => {
		backend = "file";
		kgEnabled = true;
		expect(reconcileEnabled()).toBe(true);
	});

	test("false when neither store is enabled", () => {
		backend = "file";
		kgEnabled = false;
		expect(reconcileEnabled()).toBe(false);
	});
});

describe("reconcileKnowledgeGraph (SIO-1053)", () => {
	test("no-op (no store calls) when KG is disabled", async () => {
		kgEnabled = false;
		kgProposed = [{ id: "req-1", mrUrl: "https://gitlab.com/x/-/merge_requests/264", outcome: "proposed" }];
		liveByIid.set(264, {
			mrState: "merged",
			applyStatus: "success",
			applyPipelineId: 1,
			applyPipelineUrl: "",
		});
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgSetCalls).toHaveLength(0);
	});

	test("best-effort no-op (does not throw, no writes) when getGraphStore fails", async () => {
		kgEnabled = true;
		kgStoreThrows = true;
		kgProposed = [{ id: "req-1", mrUrl: "https://gitlab.com/x/-/merge_requests/264", outcome: "proposed" }];
		liveByIid.set(264, { mrState: "merged", applyStatus: "success", applyPipelineId: 1, applyPipelineUrl: "" });
		await expect(reconcileKnowledgeGraph({ source: "cron" })).resolves.toBeUndefined();
		expect(kgSetCalls).toHaveLength(0);
	});

	test("advances a merged+apply-success change to applied", async () => {
		kgEnabled = true;
		kgProposed = [{ id: "req-1", mrUrl: "https://gitlab.com/x/-/merge_requests/264", outcome: "proposed" }];
		liveByIid.set(264, {
			mrState: "merged",
			applyStatus: "success",
			applyPipelineId: 1,
			applyPipelineUrl: "",
		});
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgSetCalls).toEqual([{ id: "req-1", outcome: "applied" }]);
	});

	test("maps closed-unmerged -> rejected and apply-failed -> failed", async () => {
		kgEnabled = true;
		kgProposed = [
			{ id: "req-closed", mrUrl: "https://gitlab.com/x/-/merge_requests/267", outcome: "proposed" },
			{ id: "req-failed", mrUrl: "https://gitlab.com/x/-/merge_requests/268", outcome: "proposed" },
		];
		liveByIid.set(267, { mrState: "closed", applyStatus: "", applyPipelineId: null, applyPipelineUrl: "" });
		liveByIid.set(268, { mrState: "merged", applyStatus: "failed", applyPipelineId: 2, applyPipelineUrl: "" });
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgSetCalls).toEqual([
			{ id: "req-closed", outcome: "rejected" },
			{ id: "req-failed", outcome: "failed" },
		]);
	});

	test("does NOT write for a transient (still-open) change", async () => {
		kgEnabled = true;
		kgProposed = [{ id: "req-open", mrUrl: "https://gitlab.com/x/-/merge_requests/269", outcome: "proposed" }];
		liveByIid.set(269, { mrState: "opened", applyStatus: "", applyPipelineId: null, applyPipelineUrl: "" });
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgSetCalls).toHaveLength(0);
	});

	test("skips a change whose mr url has no derivable iid", async () => {
		kgEnabled = true;
		kgProposed = [{ id: "req-badurl", mrUrl: "https://gitlab.com/x/no-mr-here", outcome: "proposed" }];
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgSetCalls).toHaveLength(0);
		expect(kgRepairCalls).toHaveLength(0);
	});
});

// SIO-1062: a pre-guard openMr stored gitlabFetch's raw "[409] {...}" error blob as mrUrl. The
// sweep self-heals: derive the iid from "!NNN", repair the MergeRequest url to the live web_url,
// and reconcile normally. Blobs with no derivable iid are marked failed (terminal) so they stop
// re-qualifying; transport failures never mark failed.
describe("reconcileKnowledgeGraph self-heals error-blob mr urls (SIO-1062)", () => {
	const BLOB = '[409] {"message":["Another open merge request already exists for this source branch: !256"]}';
	const REAL_URL = "https://gitlab.com/x/-/merge_requests/256";

	test("blob with !NNN + readable MR: repairs the url and advances the outcome", async () => {
		kgEnabled = true;
		kgProposed = [{ id: "req-blob", mrUrl: BLOB, outcome: "proposed" }];
		liveByIid.set(256, {
			mrState: "merged",
			webUrl: REAL_URL,
			applyStatus: "success",
			applyPipelineId: 1,
			applyPipelineUrl: "",
		});
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgRepairCalls).toEqual([{ id: "req-blob", badUrl: BLOB, goodUrl: REAL_URL }]);
		expect(kgSetCalls).toEqual([{ id: "req-blob", outcome: "applied" }]);
	});

	test("blob with !NNN but GitLab unreachable: no repair, no outcome write (retries next sweep)", async () => {
		kgEnabled = true;
		kgProposed = [{ id: "req-blob", mrUrl: BLOB, outcome: "proposed" }];
		// no liveByIid entry -> fetchMrLiveState stub returns the empty state (mrState "", no webUrl)
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgRepairCalls).toHaveLength(0);
		expect(kgSetCalls).toHaveLength(0);
	});

	test("blob with !NNN + readable but still-open MR: repairs the url, leaves the outcome transient", async () => {
		kgEnabled = true;
		kgProposed = [{ id: "req-blob", mrUrl: BLOB, outcome: "proposed" }];
		liveByIid.set(256, {
			mrState: "opened",
			webUrl: REAL_URL,
			applyStatus: "",
			applyPipelineId: null,
			applyPipelineUrl: "",
		});
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgRepairCalls).toEqual([{ id: "req-blob", badUrl: BLOB, goodUrl: REAL_URL }]);
		expect(kgSetCalls).toHaveLength(0);
	});

	test("blob without !NNN: marked failed (terminal) so it stops re-qualifying", async () => {
		kgEnabled = true;
		kgProposed = [{ id: "req-noiid", mrUrl: '[500] {"message":"boom"}', outcome: "proposed" }];
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgSetCalls).toEqual([{ id: "req-noiid", outcome: "failed" }]);
		expect(kgRepairCalls).toHaveLength(0);
	});

	test("a normal https mr url is untouched by the heal path", async () => {
		kgEnabled = true;
		kgProposed = [{ id: "req-ok", mrUrl: "https://gitlab.com/x/-/merge_requests/264", outcome: "proposed" }];
		liveByIid.set(264, { mrState: "merged", applyStatus: "success", applyPipelineId: 1, applyPipelineUrl: "" });
		await reconcileKnowledgeGraph({ source: "cron" });
		expect(kgRepairCalls).toHaveLength(0);
		expect(kgSetCalls).toEqual([{ id: "req-ok", outcome: "applied" }]);
	});
});

describe("reconcileAll reconciles the KG independently of the backend (SIO-1053)", () => {
	test("backend=file + KG enabled: agent-memory summary is zeros but the KG outcome still advances", async () => {
		backend = "file"; // agent-memory path skipped
		kgEnabled = true;
		kgProposed = [{ id: "req-1", mrUrl: "https://gitlab.com/x/-/merge_requests/264", outcome: "proposed" }];
		liveByIid.set(264, {
			mrState: "merged",
			applyStatus: "success",
			applyPipelineId: 1,
			applyPipelineUrl: "",
		});
		const summary = await reconcileAll({ source: "cron" });
		expect(summary).toMatchObject({ checked: 0, advanced: 0 }); // agent-memory did nothing
		expect(recordedDecisions).toHaveLength(0); // no agent-memory fact appended
		expect(kgSetCalls).toEqual([{ id: "req-1", outcome: "applied" }]); // but the KG advanced
	});
});
