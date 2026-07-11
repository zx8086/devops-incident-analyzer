// agent/src/iac/pipeline-watch-parity.test.ts
// SIO-984: the GitOps MR pipeline card must match the fleet flow -- show a "triggered" step before
// "running", and poll to a terminal status in one turn. A "check my MR" follow-up (pipeline-status
// intent) only extends when the user asks to "watch until done". SIO-989: the extended budget is now
// capped at the same 90s as the default; resolveWatchPipelineBudgetMs still SELECTS extended-vs-default
// by intent/phrasing, so these tests inject distinct DEF/EXT args to exercise that selection logic.
import { describe, expect, mock, test } from "bun:test";
import { resolveWatchPipelineBudgetMs } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

describe("resolveWatchPipelineBudgetMs (SIO-984)", () => {
	// Injected test values, NOT the production defaults (both are now 90s in prod per SIO-989) --
	// kept distinct here so the selection branches remain observable.
	const DEF = 90_000;
	const EXT = 300_000;

	test("post-MR watch always uses the extended budget (poll to terminal)", () => {
		expect(resolveWatchPipelineBudgetMs(true, "", DEF, EXT)).toBe(EXT);
		// even without any "watch until done" phrasing -- it's the post-openMr leg.
		expect(resolveWatchPipelineBudgetMs(true, "open an env-scoped MR", DEF, EXT)).toBe(EXT);
	});

	test("a pipeline-status follow-up stays snappy by default", () => {
		expect(resolveWatchPipelineBudgetMs(false, "check my MR", DEF, EXT)).toBe(DEF);
		expect(resolveWatchPipelineBudgetMs(false, "", DEF, EXT)).toBe(DEF);
	});

	test("a follow-up still extends when the user asks to watch until done", () => {
		expect(resolveWatchPipelineBudgetMs(false, "watch until done", DEF, EXT)).toBe(EXT);
		expect(resolveWatchPipelineBudgetMs(false, "wait for the pipeline to finish", DEF, EXT)).toBe(EXT);
	});
});

// Integration: capture the emitted iac_pipeline_progress steps. The pipeline reaches terminal on the
// first poll so the test is fast; we assert the STEP SEQUENCE the UI panel will render.
function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}

// Record every dispatchCustomEvent("iac_pipeline_progress", ...) so we can assert the step list.
function captureProgress(): { steps: Array<{ pipelineId: number | null; status: string }> } {
	const sink = { steps: [] as Array<{ pipelineId: number | null; status: string }> };
	mock.module("@langchain/core/callbacks/dispatch", () => ({
		dispatchCustomEvent: async (name: string, data: { pipelineId?: number | null; status?: string }) => {
			if (name === "iac_pipeline_progress") {
				sink.steps.push({ pipelineId: data.pipelineId ?? null, status: String(data.status) });
			}
		},
	}));
	return sink;
}

describe("watchPipeline post-MR step sequence (SIO-984)", () => {
	test("gitops post-MR watch emits a synthetic 'triggered' step before the status", async () => {
		const sink = captureProgress();
		mockTools({
			// Pipeline is already success on the first poll (fast terminal).
			gitlab_get_merge_request_pipelines: () => '[200] [{"id":999,"status":"success"}]',
			gitlab_get_pipeline_terraform_report: () => "[no child pipeline yet]",
			gitlab_get_merge_request_approvals: () => '[200] {"approved":false,"approved_by":[]}',
			// SIO-992: watchPipeline now reads the MR state; an OPEN MR keeps the plan-only path.
			gitlab_get_merge_request: () => '[200] {"state":"opened"}',
		});
		const { watchPipeline } = await import("./nodes.ts");
		const state = { intent: "gitops", mrIid: 184, messages: [] } as unknown as IacStateType;

		const out = await watchPipeline(state);

		const statuses = sink.steps.map((s) => s.status);
		// triggered (synthetic, pipelineId null) THEN the real status.
		expect(statuses[0]).toBe("triggered");
		expect(sink.steps[0]?.pipelineId).toBeNull();
		// SIO-993: the live step for a terminal PLAN pipeline is qualified ("plan succeeded"), while the
		// node's returned pipelineStatus stays the raw "success".
		expect(statuses).toContain("plan succeeded");
		expect(out.pipelineStatus).toBe("success");
	});

	test("a pipeline-status follow-up does NOT emit the synthetic 'triggered' step", async () => {
		const sink = captureProgress();
		mockTools({
			gitlab_get_merge_request_pipelines: () => '[200] [{"id":999,"status":"success"}]',
			gitlab_get_pipeline_terraform_report: () => "[no child pipeline yet]",
			gitlab_get_merge_request_approvals: () => '[200] {"approved":false,"approved_by":[]}',
			gitlab_get_merge_request: () => '[200] {"state":"opened"}',
		});
		const { watchPipeline } = await import("./nodes.ts");
		// A "check my MR" follow-up: intent pipeline-status, MR already on the thread.
		const state = {
			intent: "pipeline-status",
			mrIid: 184,
			messages: [],
		} as unknown as IacStateType;

		const out = await watchPipeline(state);

		const statuses = sink.steps.map((s) => s.status);
		expect(statuses).not.toContain("triggered"); // nothing was triggered this turn
		expect(statuses).toContain("plan succeeded"); // SIO-993: qualified live step
		expect(out.pipelineStatus).toBe("success");
	});
});

// SIO-1071: the SIO-959 cross-session fleet recovery must never hijack a gitops approve leg. The
// observed failure: a stale fleet-upgrade-dispatched fact for the SAME deployment named in the
// prompt made watchPipeline poll the OLD fleet pipeline instead of the just-opened MR's plan
// pipeline (and the iac-change fact was then written without pipeline_id/pipeline_status).
describe("watchPipeline fleet-recovery gate (SIO-1071)", () => {
	test("a gitops leg with an MR polls the MR plan pipeline, never the recalled fleet pipeline", async () => {
		const { __setAgentMemoryClient } = await import("../memory-backend.ts");
		const prevBackend = process.env.LIVE_MEMORY_BACKEND;
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		// A stale in-flight fleet upgrade for ap-cld sits in memory. With the gate, the gitops leg
		// must not even search for it -- record every searchMemory call to prove that.
		const memorySearches: Array<Record<string, string> | undefined> = [];
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory(_ref, _query, opts) {
				memorySearches.push(opts?.annotations);
				if (opts?.annotations?.kind !== "fleet-upgrade-dispatched") return [];
				return [
					{
						text: "Fleet agents on ap-cld upgrade DISPATCHED to 9.4.2.",
						score: 0.9,
						annotations: {
							kind: "fleet-upgrade-dispatched",
							deployment: "ap-cld",
							version: "9.4.2",
							pipeline_id: "2662295942",
						},
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		});
		const sink = captureProgress();
		const seen: string[] = [];
		mockTools({
			gitlab_get_pipeline: (args) => {
				seen.push(`gitlab_get_pipeline:${args.pipelineId}`);
				return '[200] {"id":2662295942,"status":"failed"}';
			},
			gitlab_get_merge_request_pipelines: () => '[200] [{"id":999,"status":"success"}]',
			gitlab_get_pipeline_terraform_report: () => "[no child pipeline yet]",
			gitlab_get_merge_request_approvals: () => '[200] {"approved":false,"approved_by":[]}',
			gitlab_get_merge_request: () => '[200] {"state":"opened"}',
		});
		const { watchPipeline } = await import("./nodes.ts");
		// The demo failure shape: gitops turn, MR just opened by openMr, prompt names the deployment
		// that has the stale dispatched fleet fact.
		const state = {
			intent: "gitops",
			mrIid: 277,
			mrUrl: "https://gitlab.com/x/-/merge_requests/277",
			messages: [{ getType: () => "human", content: "In ap-cld deployment: reduce the frozen tier ceiling" }],
		} as unknown as IacStateType;

		const out = await watchPipeline(state);

		// recovery not even attempted; the MR plan pipeline was polled instead
		expect(memorySearches.filter((a) => a?.kind === "fleet-upgrade-dispatched")).toHaveLength(0);
		expect(seen).toHaveLength(0);
		expect(out.pipelineStatus).toBe("success");
		expect(out.fleetUpgradeResult).toBeUndefined();
		expect(sink.steps.map((s) => s.status)).toContain("plan succeeded");

		__setAgentMemoryClient(null);
		if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
		else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	});
});
