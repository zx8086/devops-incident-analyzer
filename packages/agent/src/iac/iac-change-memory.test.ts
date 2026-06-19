// agent/src/iac/iac-change-memory.test.ts
//
// SIO-965: the durable gitops-change memory fact + its knowledge-graph-keyed
// annotations. These join Agent Memory to the knowledge graph on shared values
// (thread_id == KG Session.threadId, config_change_id == KG ConfigChange.id).
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	AGENT_MR_LABELS,
	buildIacChangeAnnotations,
	buildIacChangeDecision,
	buildIacChangeRationale,
} from "./nodes.ts";
import type { IacStateType } from "./state.ts";

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
			pipeline_id: "148",
			pipeline_status: "success",
		});
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
		}));
		const { teardownIac } = await import("./nodes.ts");
		teardownIac(gitopsState(state));
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
});
