// agent/src/iac/iac-change-memory.test.ts
//
// SIO-965: the durable gitops-change memory fact + its knowledge-graph-keyed
// annotations. These join Agent Memory to the knowledge graph on shared values
// (thread_id == KG Session.threadId, config_change_id == KG ConfigChange.id).
import { afterEach, describe, expect, mock, test } from "bun:test";
// SIO-1045: captured BEFORE any mock.module() call in this file runs, so afterEach can restore the
// real implementations. mock.module() is process-global and bun:test's mock.restore() does NOT undo
// it (only resets spy call state) -- without this, the last mock.module("../memory-backend.ts", ...)
// registered here leaks into every OTHER test file that runs later in the same bun test process
// (e.g. iac/local-tools.test.ts, iac/fleet-upgrade.test.ts), which is CI-only because CI's bun
// schedules test files in a different order than a local run. Same class of bug as SIO-1028
// (reference_prompt_context_mock_pollutes_direct_imports).
//
// A namespace import (`import * as ns`) is itself a LIVE VIEW: once ANY file registers a
// mock.module() for this path, bun live-patches every existing namespace binding, INCLUDING these
// captured `real*Ns` objects -- so restoring with `() => real*Ns` re-registers the very poison it
// meant to undo (a circular no-op). Spreading into a plain object at load time (before any
// mock.module() call in this file runs) copies the function VALUES, which are immune to that later
// live-patching.
import * as realMemoryBackendNs from "../memory-backend.ts";
import * as realMemoryWriterNs from "../memory-writer.ts";
import {
	AGENT_MR_LABELS,
	buildIacChangeAnnotations,
	buildIacChangeDecision,
	buildIacChangeRationale,
} from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const realMemoryBackend = { ...realMemoryBackendNs };
const realMemoryWriter = { ...realMemoryWriterNs };

// SIO-1045: re-registers the real modules so a later test FILE (not just a later test in this file)
// never observes this file's stub. Call from every describe block's afterEach, after mock.restore().
function restoreRealMemoryMocks(): void {
	mock.module("../memory-backend.ts", () => realMemoryBackend);
	mock.module("../memory-writer.ts", () => realMemoryWriter);
}

function gitopsState(over: Partial<IacStateType> = {}): IacStateType {
	return {
		requestId: "req-1",
		threadId: "thread-abc",
		intent: "gitops",
		targetDeployment: "",
		iacRequest: { workflow: "ilm-rollout", cluster: "eu-b2b" },
		proposedFiles: ["environments/eu-b2b/lifecycle-policies/metrics.json"],
		mrUrl: "https://gitlab.com/x/-/merge_requests/9",
		mrIid: 9,
		pipelineId: 148,
		pipelineStatus: "success",
		planReview: { title: "[eu-b2b] metrics: warm replicas 0" },
		reviewDecision: "approved",
		...over,
	} as unknown as IacStateType;
}

describe("AGENT_MR_LABELS", () => {
	test("are exactly the agent-generated + iac pair", () => {
		expect([...AGENT_MR_LABELS]).toEqual(["agent-generated", "iac"]);
	});
});

describe("buildIacChangeAnnotations (KG join keys)", () => {
	test("carries the knowledge-graph node keys for a gitops change", () => {
		const a = buildIacChangeAnnotations(gitopsState());
		expect(a).toMatchObject({
			kind: "iac-change",
			outcome: "completed",
			config_change_id: "req-1",
			thread_id: "thread-abc",
			deployment: "eu-b2b",
			stack: "lifecycle-policies",
			stack_instance: "eu-b2b/lifecycle-policies",
			workflow: "ilm-rollout",
			mr_url: "https://gitlab.com/x/-/merge_requests/9",
			// SIO-990: the iid is persisted so cross-thread recall can re-poll the exact MR.
			mr_iid: "9",
			pipeline_id: "148",
			pipeline_status: "success",
		});
	});

	// SIO-996: the rich change descriptor (plan-review title) is persisted VERBATIM as change_summary
	// so a cross-thread recall reads the exact keys, not the service-paraphrased fact text.
	test("carries change_summary from the plan-review title", () => {
		const a = buildIacChangeAnnotations(gitopsState());
		expect(a.change_summary).toBe("[eu-b2b] metrics: warm replicas 0");
	});

	test("omits change_summary when there is no plan-review title", () => {
		const a = buildIacChangeAnnotations(gitopsState({ planReview: null }));
		expect(a.change_summary).toBeUndefined();
	});

	test("includes version for a version-upgrade and stamps the failed outcome", () => {
		const a = buildIacChangeAnnotations(
			gitopsState({
				iacRequest: { workflow: "version-upgrade", cluster: "eu-b2b", version: "9.4.2", isProd: false },
				proposedFiles: ["environments/_deployments/eu-b2b.json"],
				pipelineStatus: "failed",
			}),
		);
		expect(a.version).toBe("9.4.2");
		expect(a.stack).toBe("deployments");
		expect(a.outcome).toBe("pipeline-failed");
	});

	// SIO-1071: a proposer that misses proposedFiles must still produce the stack_instance key the
	// deterministic recall (memoryEnrichIac) filters on -- fall back to the workflow's stack, the
	// same derivation the recall side uses (stackInstanceId in graph-knowledge.ts). Without it the
	// fact is unfindable by {stack_instance} and "Prior learnings (memory)" never renders.
	test("falls back to the workflow's stack when proposedFiles is empty (SIO-1071)", () => {
		const a = buildIacChangeAnnotations(
			gitopsState({
				iacRequest: { workflow: "tier-resize", cluster: "ap-cld" },
				proposedFiles: [],
			} as unknown as Partial<IacStateType>),
		);
		expect(a.stack).toBe("deployments");
		expect(a.stack_instance).toBe("ap-cld/deployments");
	});

	test("omits stack when neither proposedFiles nor a known workflow resolves one", () => {
		const a = buildIacChangeAnnotations(
			gitopsState({
				iacRequest: { workflow: "other", cluster: "ap-cld" },
				proposedFiles: [],
			} as unknown as Partial<IacStateType>),
		);
		expect(a.stack).toBeUndefined();
		expect(a.stack_instance).toBeUndefined();
	});

	test("omits unknown pipeline status and absent fields", () => {
		const a = buildIacChangeAnnotations(
			gitopsState({ threadId: "", pipelineId: null, pipelineStatus: "unknown", mrUrl: "" }),
		);
		expect(a.thread_id).toBeUndefined();
		expect(a.pipeline_id).toBeUndefined();
		expect(a.pipeline_status).toBeUndefined();
		expect(a.mr_url).toBeUndefined();
		// config_change_id is always present (the KG ConfigChange join key).
		expect(a.config_change_id).toBe("req-1");
	});
});

describe("buildIacChangeDecision / Rationale", () => {
	test("decision is self-contained with scope + title", () => {
		expect(buildIacChangeDecision(gitopsState())).toBe(
			"Elastic IaC change proposed (MR open) on eu-b2b/lifecycle-policies: [eu-b2b] metrics: warm replicas 0.",
		);
	});

	test("decision reflects a failed pipeline", () => {
		expect(buildIacChangeDecision(gitopsState({ pipelineStatus: "failed" }))).toContain("change FAILED CI");
	});

	// SIO-1071: the decision scope gets the same workflow fallback as the annotations.
	test("decision scope falls back to the workflow's stack when proposedFiles is empty", () => {
		const decision = buildIacChangeDecision(
			gitopsState({
				iacRequest: { workflow: "tier-resize", cluster: "ap-cld" },
				proposedFiles: [],
				planReview: { title: "[ap-cld] frozen -> max 8g: tier-resize" },
			} as unknown as Partial<IacStateType>),
		);
		expect(decision).toContain("on ap-cld/deployments:");
	});

	// SIO-989: the richer per-field title flows verbatim into the durable decision (the fact that is
	// later recalled on a fresh "check my MR"), and the decision stays a single clean line.
	test("decision carries the enriched per-field title and stays one line", () => {
		const decision = buildIacChangeDecision(
			gitopsState({
				planReview: {
					title:
						"[eu-b2b] metrics: warm forcemerge.max_num_segments=1 shrink.number_of_shards=1, cold allocate.number_of_replicas=0: ilm-rollout",
				} as IacStateType["planReview"],
			}),
		);
		expect(decision).toContain("warm forcemerge.max_num_segments=1 shrink.number_of_shards=1");
		expect(decision).toContain("cold allocate.number_of_replicas=0");
		expect(decision.split("\n")).toHaveLength(1);
	});

	test("rationale names the MR, pipeline, and file count", () => {
		const r = buildIacChangeRationale(gitopsState());
		expect(r).toContain("https://gitlab.com/x/-/merge_requests/9");
		expect(r).toContain("pipeline #148 success");
		expect(r).toContain("1 file(s)");
	});
});

// SIO-965: teardownIac writes the durable iac-change fact (with KG-keyed annotations)
// when a gitops turn opened an MR on the agent-memory backend, and skips it otherwise.
describe("teardownIac durable iac-change fact (gate)", () => {
	afterEach(() => {
		mock.restore();
		// SIO-1045: undo this block's mock.module("../memory-backend.ts", ...) so it cannot leak into
		// a test file that runs later in the same bun test process.
		restoreRealMemoryMocks();
	});

	async function runTeardown(state: Partial<IacStateType>, backend: "agent-memory" | "file") {
		const calls: Array<{ requestId: string; decision: string; annotations?: Record<string, string> }> = [];
		mock.module("../memory-writer.ts", () => ({
			appendDailyLog: () => {},
			recordKeyDecision: (d: { requestId: string; decision: string; annotations?: Record<string, string> }) =>
				calls.push(d),
		}));
		mock.module("../memory-backend.ts", () => ({
			selectedBackend: () => backend,
			recallInFlightFleetUpgrades: async () => [],
			// SIO-988: teardownIac now recalls the iac-change intent for enrichment; this gate
			// test only asserts the WRITE, so stub the recall surface to a miss (own the complete
			// backend mock so a sibling suite's stub can't win -- mock.module is process-global).
			searchAgentMemory: async () => [],
			dedupeHitsBy: <T>(hits: T[]) => hits,
		}));
		const { teardownIac } = await import("./nodes.ts");
		await teardownIac(gitopsState(state));
		return calls;
	}

	test("records the fact with KG join keys when an MR exists on agent-memory", async () => {
		const calls = await runTeardown({}, "agent-memory");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.requestId).toBe("req-1");
		expect(calls[0]?.annotations).toMatchObject({
			kind: "iac-change",
			config_change_id: "req-1",
			thread_id: "thread-abc",
			deployment: "eu-b2b",
			stack: "lifecycle-policies",
			mr_url: "https://gitlab.com/x/-/merge_requests/9",
		});
	});

	test("skips the durable fact on the file backend (PR-gated learnings)", async () => {
		expect(await runTeardown({}, "file")).toHaveLength(0);
	});

	test("skips the durable fact when no MR was opened (rejected/blocked turn)", async () => {
		expect(await runTeardown({ mrUrl: "" }, "agent-memory")).toHaveLength(0);
	});

	// SIO-992: a "check my MR" (pipeline-status) re-check ALSO records the iac-change fact, so the
	// success step exists for recallSessionProgress to surface (the proposal turn wrote "running").
	test("records the fact on a pipeline-status re-check (the success step of the progression)", async () => {
		const calls = await runTeardown({ intent: "pipeline-status", pipelineStatus: "success" }, "agent-memory");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.annotations).toMatchObject({
			kind: "iac-change",
			mr_url: "https://gitlab.com/x/-/merge_requests/9",
			pipeline_status: "success",
		});
	});
});

// SIO-988: the rendered teardown message -- status-aware footer + the "Change:" intent line
// (in-turn planReview/iacRequest first, durable-memory recall by mr_url as the fresh-turn fallback).
describe("teardownIac message (footer + intent enrichment)", () => {
	afterEach(() => {
		mock.restore();
		// SIO-1045: undo this block's mock.module("../memory-backend.ts", ...) so it cannot leak into
		// a test file that runs later in the same bun test process.
		restoreRealMemoryMocks();
	});

	const OLD_FOOTER = "Review and apply manually in GitLab. I never merge or apply.";

	// Render the teardown message with the memory WRITE path stubbed to a no-op and the READ
	// path (searchAgentMemory) controllable. searchCalls records the recall filter so a test can
	// assert it was keyed on mr_url; hits is what the recall returns.
	async function render(
		// Loosely typed like gitopsState's input: planReview is given a partial { title } literal
		// (gitopsState casts the merged state to IacStateType), so don't strict-check each field here.
		state: Record<string, unknown>,
		opts: { backend: "agent-memory" | "file"; hits?: Array<{ text: string; annotations: Record<string, string> }> },
	) {
		const searchCalls: Array<{ query: string; filter?: Record<string, string> }> = [];
		mock.module("../memory-writer.ts", () => ({
			appendDailyLog: () => {},
			recordKeyDecision: () => {},
		}));
		mock.module("../memory-backend.ts", () => ({
			selectedBackend: () => opts.backend,
			recallInFlightFleetUpgrades: async () => [],
			searchAgentMemory: async (_agent: string, query: string, filter?: Record<string, string>) => {
				searchCalls.push({ query, filter });
				return opts.hits ?? [];
			},
			dedupeHitsBy: <T extends { annotations: Record<string, string> }>(
				hits: T[],
				keyFn: (h: T) => string | undefined,
			) => {
				const seen = new Set<string>();
				return hits.filter((h, i) => {
					const k = keyFn(h) ?? `nokey:${i}`;
					if (seen.has(k)) return false;
					seen.add(k);
					return true;
				});
			},
		}));
		const { teardownIac } = await import("./nodes.ts");
		const out = await teardownIac(gitopsState(state as Partial<IacStateType>));
		return { text: String(out.messages?.[0]?.content), searchCalls };
	}

	test("success + approved, MR state unread: staged + nothing-applied footer, no bare old footer", async () => {
		const { text } = await render(
			{ pipelineStatus: "success", approvalState: { approved: true, required: 0 } },
			{ backend: "file" },
		);
		// SIO-991/SIO-992: the footer makes explicit the plan CI succeeded and the change is STAGED,
		// not applied (CI only planned). mrState is unread here ("") so it uses the generic open note.
		expect(text).toContain("The plan CI succeeded");
		expect(text).toContain("staged");
		expect(text).toContain("Nothing has been merged or applied");
		expect(text).toContain("I never merge or apply.");
		// the old unconditional footer must no longer appear verbatim on a clean success
		expect(text).not.toContain(OLD_FOOTER);
		// SIO-991/SIO-992: the qualified Pipeline line says "plan succeeded (plan ready; nothing applied yet)".
		expect(text).toContain("plan succeeded (plan ready; nothing applied yet)");
	});

	// SIO-992: with the MR read as still OPEN, the footer + a dedicated MR line say it's not merged.
	test("success, MR OPEN: says the MR is open and not merged/applied", async () => {
		const { text } = await render(
			{ pipelineStatus: "success", mrState: "opened", approvalState: { approved: true, required: 0 } },
			{ backend: "file" },
		);
		expect(text).toContain("MR: OPEN (not merged");
		expect(text).toContain("The MR is still OPEN — nothing has been merged or applied.");
		expect(text).toContain("Merge in GitLab to trigger the apply");
	});

	// SIO-993/SIO-995: with the MR MERGED, the message reports the REAL apply-JOB status (parent ->
	// child -> apply:* job), not the parent pipeline's transient status. Only a confirmed apply-job
	// SUCCESS reads as LIVE; running/failed/not-started must NEVER read as live.
	test("merged + apply-job SUCCEEDED: says applied, the change is LIVE", async () => {
		const { text } = await render(
			{
				pipelineStatus: "success",
				mrState: "merged",
				applyPipelineStatus: "success",
				applyPipelineId: 555,
				applyPipelineUrl: "https://gitlab/jobs/555",
				approvalState: { approved: true, required: 0 },
			},
			{ backend: "file" },
		);
		expect(text).toContain("MR: MERGED");
		expect(text).toContain("Apply: #555 SUCCEEDED on main — the change is LIVE.");
		expect(text).toContain("Merged and APPLIED");
		expect(text).toContain("the apply job on main succeeded");
		expect(text).toContain("the change is now live");
		expect(text).not.toContain("ready to merge");
		expect(text).toContain("I never merge or apply.");
	});

	// SIO-995 REGRESSION GUARD (the MR 196 false-positive): the apply JOB was still RUNNING when
	// checked (the parent pipeline reported success transiently). The message MUST say applying/NOT
	// live -- never "APPLIED" or "LIVE".
	test("merged + apply-job RUNNING: says applying, NOT live (never reports applied)", async () => {
		const { text } = await render(
			{ pipelineStatus: "success", mrState: "merged", applyPipelineStatus: "running", applyPipelineId: 556 },
			{ backend: "file" },
		);
		expect(text).toContain("Apply: #556 running on main — NOT live until it succeeds.");
		expect(text).toContain("the terraform apply is RUNNING on main");
		expect(text).toContain("NOT live until the apply job succeeds");
		expect(text).toContain('Ask "check my MR" again');
		// the false-positive must be impossible
		expect(text).not.toContain("the change is LIVE");
		expect(text).not.toContain("Merged and APPLIED");
		expect(text).not.toContain("change is now live");
	});

	test("merged + apply-job FAILED: says NOT live", async () => {
		const { text } = await render(
			{ pipelineStatus: "success", mrState: "merged", applyPipelineStatus: "failed", applyPipelineId: 557 },
			{ backend: "file" },
		);
		expect(text).toContain("Apply: #557 FAILED on main — the change is NOT live.");
		expect(text).toContain("the apply on main FAILED");
		expect(text).not.toContain("the change is LIVE");
		expect(text).not.toContain("Merged and APPLIED");
	});

	test("merged + apply job not appeared yet (status ''): says NOT live, re-check (never applied)", async () => {
		const { text } = await render(
			{ pipelineStatus: "success", mrState: "merged", approvalState: { approved: true, required: 0 } },
			{ backend: "file" },
		);
		expect(text).toContain("MR: MERGED");
		expect(text).toContain("Apply: not started yet on main");
		expect(text).toContain("NOT live until the apply job succeeds");
		expect(text).not.toContain("the change is LIVE");
		expect(text).not.toContain("Merged and APPLIED");
		expect(text).not.toContain("ready to merge");
	});

	test("success + not approved: footer flags missing approval", async () => {
		const { text } = await render(
			{ pipelineStatus: "success", approvalState: { approved: false, required: 1 } },
			{ backend: "file" },
		);
		expect(text).toContain("not yet approved");
	});

	test("failed: footer says fix before merging", async () => {
		const { text } = await render({ pipelineStatus: "failed", approvalState: null }, { backend: "file" });
		expect(text).toContain("Pipeline failed");
	});

	test("running (non-terminal): keeps the original review-and-apply footer", async () => {
		const { text } = await render({ pipelineStatus: "running", approvalState: null }, { backend: "file" });
		expect(text).toContain(OLD_FOOTER);
	});

	test("enrichment in-turn: uses planReview.title without any memory call", async () => {
		const { text, searchCalls } = await render(
			{ planReview: { title: "Bind logs-custom ILM to logs streams" }, pipelineStatus: "success" },
			{ backend: "file" },
		);
		expect(text).toContain("Change: Bind logs-custom ILM to logs streams");
		expect(searchCalls).toHaveLength(0); // file backend short-circuits the recall
	});

	test("enrichment fallback: recalls the iac-change fact by mr_url when in-turn context is empty", async () => {
		const recalled = "Elastic IaC change proposed (MR open) on eu-b2b/cluster-defaults: bind logs-custom ILM.";
		const { text, searchCalls } = await render(
			{ iacRequest: null, planReview: null, pipelineStatus: "success" },
			{ backend: "agent-memory", hits: [{ text: recalled, annotations: { config_change_id: "c1" } }] },
		);
		expect(text).toContain(`Change: ${recalled}`);
		expect(searchCalls).toHaveLength(1);
		expect(searchCalls[0]?.filter).toEqual({
			kind: "iac-change",
			mr_url: "https://gitlab.com/x/-/merge_requests/9",
		});
	});

	// SIO-996: prefer the verbatim change_summary annotation over the paraphrased fact text.
	test("enrichment fallback: prefers the change_summary annotation over the fact text", async () => {
		const { text } = await render(
			{ iacRequest: null, planReview: null, pipelineStatus: "success" },
			{
				backend: "agent-memory",
				hits: [
					{
						text: "Elastic IaC change proposed on eu-b2b/cluster-settings: a reworded paraphrase.",
						annotations: {
							config_change_id: "c1",
							change_summary: "[eu-b2b] removed xpack.monitoring.collection.interval: cluster-settings-edit",
						},
					},
				],
			},
		);
		expect(text).toContain("Change: [eu-b2b] removed xpack.monitoring.collection.interval: cluster-settings-edit");
		expect(text).not.toContain("a reworded paraphrase");
	});

	// SIO-996: the proposal fact carries change_summary; a later re-check fact (different
	// config_change_id, no planReview) does not. Recall must pick the one that has it, regardless of order.
	test("enrichment fallback: picks the hit carrying change_summary even when it is not first", async () => {
		const { text } = await render(
			{ iacRequest: null, planReview: null, pipelineStatus: "success" },
			{
				backend: "agent-memory",
				hits: [
					{ text: "re-check fact, no descriptor", annotations: { config_change_id: "c2" } },
					{
						text: "proposal fact",
						annotations: {
							config_change_id: "c1",
							change_summary: "[eu-b2b] removed search.max_buckets: cluster-settings-edit",
						},
					},
				],
			},
		);
		expect(text).toContain("Change: [eu-b2b] removed search.max_buckets: cluster-settings-edit");
	});

	test("enrichment fallback: dedups hits sharing a key into one Change line", async () => {
		const dup = { text: "bind logs-custom ILM.", annotations: { config_change_id: "c1" } };
		const { text } = await render(
			{ iacRequest: null, planReview: null, pipelineStatus: "success" },
			{ backend: "agent-memory", hits: [dup, { ...dup, text: "Bind the logs-custom ILM policy." }] },
		);
		expect(text.split("\n").filter((l) => l.startsWith("Change:"))).toHaveLength(1);
	});

	test("memory off + no in-turn context: no Change line, footer still status-aware", async () => {
		const { text } = await render(
			{ iacRequest: null, planReview: null, pipelineStatus: "success", approvalState: { approved: true } },
			{ backend: "file" },
		);
		expect(text).not.toContain("Change:");
		expect(text).toContain("The plan CI succeeded");
		expect(text).toContain("staged");
	});
});

// SIO-990: cross-thread MR recall. recallLastIacChange resolves the most recent durable iac-change
// fact (mr_url + mr_iid + deployment + pipeline_id) so a fresh thread after a clear/reload can answer
// "check my MR" without asking "which MR?". Deterministic over the searchAgentMemory + dedupeHitsBy
// shape; agent-memory backend only.
describe("recallLastIacChange (SIO-990)", () => {
	afterEach(() => {
		mock.restore();
		// SIO-1045: undo this block's mock.module("../memory-backend.ts", ...) so it cannot leak into
		// a test file that runs later in the same bun test process.
		restoreRealMemoryMocks();
	});

	async function recall(opts: {
		backend: "agent-memory" | "file";
		hits?: Array<{ text: string; annotations: Record<string, string> }>;
		deployment?: string;
	}) {
		const searchCalls: Array<{ query: string; filter?: Record<string, string> }> = [];
		mock.module("../memory-backend.ts", () => ({
			selectedBackend: () => opts.backend,
			recallInFlightFleetUpgrades: async () => [],
			searchAgentMemory: async (_agent: string, query: string, filter?: Record<string, string>) => {
				searchCalls.push({ query, filter });
				return opts.hits ?? [];
			},
			dedupeHitsBy: <T>(hits: T[]) => hits,
		}));
		const { recallLastIacChange } = await import("./nodes.ts");
		const result = await recallLastIacChange(opts.deployment);
		return { result, searchCalls };
	}

	test("returns null on the file backend (no agent-memory recall)", async () => {
		const { result } = await recall({ backend: "file" });
		expect(result).toBeNull();
	});

	test("returns null when no iac-change fact is found", async () => {
		const { result } = await recall({ backend: "agent-memory", hits: [] });
		expect(result).toBeNull();
	});

	test("resolves mr_url + mr_iid + pipeline_id + deployment from the top hit", async () => {
		const { result, searchCalls } = await recall({
			backend: "agent-memory",
			deployment: "eu-b2b",
			hits: [
				{
					text: "Elastic IaC change proposed (MR open) on eu-b2b/lifecycle-policies: ...",
					annotations: {
						kind: "iac-change",
						mr_url: "https://gitlab.com/x/-/merge_requests/189",
						mr_iid: "189",
						pipeline_id: "2616365700",
						deployment: "eu-b2b",
						stack: "lifecycle-policies",
					},
				},
			],
		});
		expect(result).toMatchObject({
			mrUrl: "https://gitlab.com/x/-/merge_requests/189",
			mrIid: 189,
			pipelineId: 2616365700,
			deployment: "eu-b2b",
			stack: "lifecycle-policies",
		});
		// Scoped the search to the deployment filter.
		expect(searchCalls[0]?.filter).toMatchObject({ kind: "iac-change", deployment: "eu-b2b" });
	});

	test("tolerates a fact with no mr_iid (older facts predate the iid annotation)", async () => {
		const { result } = await recall({
			backend: "agent-memory",
			hits: [
				{
					text: "older change",
					annotations: { kind: "iac-change", mr_url: "https://gitlab.com/x/-/merge_requests/7" },
				},
			],
		});
		expect(result?.mrUrl).toBe("https://gitlab.com/x/-/merge_requests/7");
		expect(result?.mrIid).toBeUndefined();
	});

	test("omits the deployment filter when called without one (most-recent across deployments)", async () => {
		const { searchCalls } = await recall({ backend: "agent-memory", hits: [] });
		expect(searchCalls[0]?.filter).toMatchObject({ kind: "iac-change" });
		expect(searchCalls[0]?.filter?.deployment).toBeUndefined();
	});
});

// SIO-992: session-scoped progression recall. recallSessionProgress retrieves THIS session's own
// iac-change facts (scoped via allSessions:false), keyed on pipeline_status, deduped + ordered into
// a proposed -> running -> success trail. Drives the "Progress so far" line on a "check my MR" turn.
describe("recallSessionProgress (SIO-992)", () => {
	afterEach(() => {
		mock.restore();
		// SIO-1045: undo this block's mock.module("../memory-backend.ts", ...) so it cannot leak into
		// a test file that runs later in the same bun test process.
		restoreRealMemoryMocks();
	});

	async function recall(opts: {
		backend: "agent-memory" | "file";
		hits?: Array<{ text: string; annotations: Record<string, string> }>;
	}) {
		const searchCalls: Array<{ query: string; filter?: Record<string, string>; opts?: { allSessions?: boolean } }> = [];
		mock.module("../memory-backend.ts", () => ({
			selectedBackend: () => opts.backend,
			recallInFlightFleetUpgrades: async () => [],
			searchAgentMemory: async (
				_agent: string,
				query: string,
				filter?: Record<string, string>,
				_limit?: number,
				searchOpts?: { allSessions?: boolean },
			) => {
				searchCalls.push({ query, filter, opts: searchOpts });
				return opts.hits ?? [];
			},
			// real dedup-by-key so a re-recorded status collapses, like the live helper.
			dedupeHitsBy: <T extends { annotations: Record<string, string> }>(
				hits: T[],
				keyFn: (h: T) => string | undefined,
			) => {
				const seen = new Set<string>();
				return hits.filter((h, i) => {
					const k = keyFn(h) ?? `nokey:${i}`;
					if (seen.has(k)) return false;
					seen.add(k);
					return true;
				});
			},
		}));
		const { recallSessionProgress } = await import("./nodes.ts");
		const steps = await recallSessionProgress("https://gitlab.com/x/-/merge_requests/9");
		return { steps, searchCalls };
	}

	test("returns [] on the file backend", async () => {
		const { steps } = await recall({ backend: "file" });
		expect(steps).toEqual([]);
	});

	test("scopes the search to the CURRENT session (allSessions:false) and filters by mr_url", async () => {
		const { searchCalls } = await recall({ backend: "agent-memory", hits: [] });
		expect(searchCalls[0]?.opts).toMatchObject({ allSessions: false });
		expect(searchCalls[0]?.filter).toMatchObject({
			kind: "iac-change",
			mr_url: "https://gitlab.com/x/-/merge_requests/9",
		});
	});

	test("orders steps proposed -> running -> success and dedups repeats", async () => {
		const { steps } = await recall({
			backend: "agent-memory",
			// out of order + a duplicate "success" re-record
			hits: [
				{ text: "success again", annotations: { kind: "iac-change", pipeline_status: "success" } },
				{ text: "running", annotations: { kind: "iac-change", pipeline_status: "running" } },
				{ text: "success", annotations: { kind: "iac-change", pipeline_status: "success" } },
			],
		});
		expect(steps.map((s) => s.pipelineStatus)).toEqual(["running", "success"]);
	});
});
