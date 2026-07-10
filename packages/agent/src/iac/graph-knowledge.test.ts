// agent/src/iac/graph-knowledge.test.ts
//
// SIO-1045: this file OWNS a mock.module("../memory-backend.ts", ...) registered at file scope,
// BEFORE the static imports below (both this file and ./graph-knowledge.ts / ./nodes.ts statically
// import ../memory-backend.ts). See fleet-upgrade.test.ts for the full rationale: bun's mock.module
// is process-global and last-registration-wins, and a sibling file's own restore
// (iac-change-memory.test.ts / reconcile.test.ts) is not sufficient to protect this file across every
// CI execution order. The factory re-exports the REAL module verbatim, so this file's direct use of
// __setAgentMemoryClient / clearActiveMemorySession / __resetMemoryQueue is unchanged.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _setGraphStoreForTesting, type GraphRow, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import { HumanMessage } from "@langchain/core/messages";
import * as realMemoryBackend from "../memory-backend.ts";

mock.module("../memory-backend.ts", () => realMemoryBackend);

import { __resetMemoryQueue, __setAgentMemoryClient, clearActiveMemorySession } from "../memory-backend.ts";
import {
	graphEnrichIac,
	memoryEnrichIac,
	recordIacEntities,
	recordIacOutcome,
	recordIacPromptNode,
} from "./graph-knowledge.ts";
import { stackForWorkflow, stackFromPaths } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const prev = process.env.KNOWLEDGE_GRAPH_ENABLED;
const prevBackend = process.env.LIVE_MEMORY_BACKEND;
const prevEnabled = process.env.LIVE_MEMORY_ENABLED;
const prevRawPrompts = process.env.LIVE_MEMORY_RAW_PROMPTS_ENABLED;

function iacState(over: Partial<IacStateType> = {}): IacStateType {
	return {
		requestId: "req-1",
		targetDeployment: "eu-b2b",
		proposedFiles: ["lifecycle-policies/metrics.json"],
		mrUrl: "https://gitlab.com/x/-/merge_requests/9",
		iacRequest: { workflow: "ilm-rollout", cluster: "eu-b2b" },
		planReview: null,
		iacGraphContext: "",
		...over,
	} as unknown as IacStateType;
}

beforeEach(() => {
	_setGraphStoreForTesting(null);
});

afterEach(() => {
	if (prev === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
	else process.env.KNOWLEDGE_GRAPH_ENABLED = prev;
	if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
	else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	if (prevEnabled === undefined) delete process.env.LIVE_MEMORY_ENABLED;
	else process.env.LIVE_MEMORY_ENABLED = prevEnabled;
	if (prevRawPrompts === undefined) delete process.env.LIVE_MEMORY_RAW_PROMPTS_ENABLED;
	else process.env.LIVE_MEMORY_RAW_PROMPTS_ENABLED = prevRawPrompts;
	_setGraphStoreForTesting(null);
	__setAgentMemoryClient(null);
	__resetMemoryQueue();
	clearActiveMemorySession();
	// SIO-1045: re-claim ownership after every test in this file (see the file-scope comment above).
	mock.module("../memory-backend.ts", () => realMemoryBackend);
});

describe("recordIacEntities", () => {
	test("is a no-op when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const result = await recordIacEntities(iacState());
		expect(result).toEqual({});
		expect(store.calls).toEqual([]);
	});

	test("writes the deployment + config-change + MR when enabled", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordIacEntities(iacState());
		expect(
			store.calls.some((c) => c.cypher.includes("MERGE (d:ElasticDeployment") && c.params?.name === "eu-b2b"),
		).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (c:ConfigChange") && c.params?.id === "req-1")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("PROPOSED_IN"))).toBe(true);
	});

	// SIO-965: the three-layer attachments (workflow/session/stack-instance + outcome).
	test("writes VIA_WORKFLOW/IN_SESSION/TARGETS + proposed outcome when enabled", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordIacEntities(
			iacState({
				threadId: "thread-1",
				proposedFiles: ["environments/eu-b2b/lifecycle-policies/metrics.json"],
			}),
		);
		expect(store.calls.some((c) => c.cypher.includes("VIA_WORKFLOW") && c.params?.name === "ilm-rollout")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("IN_SESSION") && c.params?.tid === "thread-1")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("TARGETS") && c.params?.sid === "eu-b2b/lifecycle-policies")).toBe(
			true,
		);
		const change = store.calls.find((c) => c.cypher.includes("MERGE (c:ConfigChange"));
		expect(change?.params?.outcome).toBe("proposed");
	});

	test("is a no-op when no deployment can be resolved", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const result = await recordIacEntities(iacState({ targetDeployment: "", iacRequest: null }));
		expect(result).toEqual({});
		expect(store.calls).toEqual([]);
	});
});

describe("recordIacPromptNode (SIO-1038)", () => {
	// A throwing store proves sink 1 soft-fails without breaking the turn.
	class ThrowingGraphStore extends InMemoryGraphStore {
		override async run<T extends GraphRow = GraphRow>(): Promise<T[]> {
			throw new Error("boom");
		}
	}

	const promptState = (over: Partial<IacStateType> = {}) =>
		iacState({ messages: [new HumanMessage("Delete the ILM file on eu-b2b")], threadId: "thread-abc", ...over });

	test("is a no-op when requestId is empty", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const result = await recordIacPromptNode(promptState({ requestId: "" }));
		expect(result).toEqual({});
		expect(store.calls).toEqual([]);
	});

	test("is a no-op when there is no human message", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const result = await recordIacPromptNode(iacState({ messages: [] }));
		expect(result).toEqual({});
		expect(store.calls).toEqual([]);
	});

	test("writes the Prompt node + PROMPTED_IN with FULL untruncated text when the KG is enabled", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		// >280 chars proves there is NO .slice(0, 280) cap (unlike Incident.summary).
		const longPrompt = `upgrade fleet agents: ${"host-".repeat(80)}`;
		await recordIacPromptNode(promptState({ messages: [new HumanMessage(longPrompt)] }));
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (p:Prompt"));
		expect(merge?.params?.id).toBe("req-1");
		expect(merge?.params?.text).toBe(longPrompt);
		expect((merge?.params?.text as string).length).toBeGreaterThan(280);
		expect(merge?.params?.agent).toBe("elastic-iac");
		expect(store.calls.some((c) => c.cypher.includes("PROMPTED_IN") && c.params?.tid === "thread-abc")).toBe(true);
	});

	test("does not write to the graph when the KG is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const result = await recordIacPromptNode(promptState());
		expect(result).toEqual({});
		expect(store.calls).toEqual([]);
	});

	test("still records the raw agent-memory fact when the KG is off but the backend + raw flag are on", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		process.env.LIVE_MEMORY_ENABLED = "true";
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		process.env.LIVE_MEMORY_RAW_PROMPTS_ENABLED = "true";
		const { setActiveMemorySession, flushAgentMemory } = await import("../memory-backend.ts");
		const facts: string[] = [];
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts(_ref, f) {
				facts.push(...f);
				return { blockIds: [], acceptedCount: f.length, rejectedCount: 0 };
			},
			async addMessages(_ref, m) {
				return { blockIds: [], acceptedCount: m.length, rejectedCount: 0 };
			},
			async searchMemory() {
				return [];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true, status: "ok" };
			},
		});
		setActiveMemorySession("elastic-iac", "thread-abc");

		await recordIacPromptNode(promptState({ messages: [new HumanMessage("just a converse question")] }));
		await flushAgentMemory();
		expect(facts).toContain("just a converse question");
	});

	test("soft-fails to {} when the graph store throws (sink 1) and does not break the turn", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		_setGraphStoreForTesting(new ThrowingGraphStore());
		const result = await recordIacPromptNode(promptState());
		expect(result).toEqual({});
	});
});

describe("graphEnrichIac", () => {
	test("is a no-op when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const result = await graphEnrichIac(iacState());
		expect(result).toEqual({});
	});

	test("produces iacGraphContext from the deployment's change history when enabled", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("CHANGED_BY", [
			{ id: "req-0", workflow: "tier-resize", summary: "warm -> 8g", mrUrl: "u0", createdAt: "2026-06-18" },
		]);
		_setGraphStoreForTesting(store);
		const result = await graphEnrichIac(iacState());
		expect(result.iacGraphContext).toContain("Recent changes to eu-b2b");
		expect(result.iacGraphContext).toContain("tier-resize: warm -> 8g");
	});

	test("soft-fails to {} when the store throws", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.run = async () => {
			throw new Error("graph down");
		};
		_setGraphStoreForTesting(store);
		const result = await graphEnrichIac(iacState());
		expect(result).toEqual({});
	});

	// SIO-969: the latest prior change to the targeted (deployment, stack) cell is exposed
	// structurally so reviewPlan can raise a "previous attempt failed" risk.
	test("exposes lastStackInstanceOutcome from the most-recent stack-instance change", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		// reader returns most-recent-first; [0] is the latest attempt
		store.stub("TARGETS", [
			{
				id: "c2",
				workflow: "ilm-rollout",
				summary: "warm 30d",
				outcome: "failed",
				mrUrl: "u2",
				createdAt: "2026-06-18",
			},
			{
				id: "c1",
				workflow: "ilm-rollout",
				summary: "warm 14d",
				outcome: "applied",
				mrUrl: "u1",
				createdAt: "2026-06-10",
			},
		]);
		_setGraphStoreForTesting(store);
		// proposedFiles must hit the environments/<dep>/<stack>/ layout so stackFromPaths resolves
		// a stack-instance id and changeHistoryForStackInstance (the TARGETS reader) runs.
		const result = await graphEnrichIac(
			iacState({ proposedFiles: ["environments/eu-b2b/lifecycle-policies/metrics.json"] }),
		);
		expect(result.lastStackInstanceOutcome).toEqual({ outcome: "failed", mrUrl: "u2", summary: "warm 30d" });
	});
});

// SIO-970: cross-session agent-memory recall node. Independent of the KG flag -- gated
// only on LIVE_MEMORY_BACKEND=agent-memory.
describe("memoryEnrichIac", () => {
	const prevBackend = process.env.LIVE_MEMORY_BACKEND;
	afterEach(() => {
		__setAgentMemoryClient(null);
		if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
		else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	});

	test("is a no-op when the agent-memory backend is not selected", async () => {
		delete process.env.LIVE_MEMORY_BACKEND;
		const result = await memoryEnrichIac(
			iacState({ proposedFiles: ["environments/eu-b2b/lifecycle-policies/metrics.json"] }),
		);
		expect(result).toEqual({});
	});

	test("recalls prior learnings filtered by stack_instance + kind, rendered as markdown", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {},
			async addMessages() {},
			async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
				// proves the change-path annotation key is the recall filter
				expect(opts?.annotations).toEqual({ stack_instance: "eu-b2b/lifecycle-policies", kind: "iac-change" });
				return [
					{
						text: "Set metrics warm to 14d; 30d failed CI on shard count.",
						score: 0.9,
						annotations: { workflow: "ilm-rollout", outcome: "applied" },
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
			// biome-ignore lint/suspicious/noExplicitAny: SIO-970 - test stub for the AgentMemoryClient surface
		} as any);
		const result = await memoryEnrichIac(
			iacState({ proposedFiles: ["environments/eu-b2b/lifecycle-policies/metrics.json"] }),
		);
		expect(result.priorLearnings).toContain("Set metrics warm to 14d");
		expect(result.priorLearnings).toContain("[ilm-rollout applied]");
	});

	test("is a no-op when no stack-instance can be resolved from the proposed paths OR the workflow", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		// proposedFiles don't fit the env layout AND the workflow has no stack ("other" is the only
		// workflow with no proposer -> no stack), so neither source yields a key.
		const result = await memoryEnrichIac(
			iacState({
				proposedFiles: ["modules/slo/main.tf"],
				iacRequest: { workflow: "other", isProd: false, cluster: "eu-b2b" },
			}),
		);
		expect(result).toEqual({});
	});

	// SIO-985: the enrich/recall nodes run BEFORE draftChange, so proposedFiles is EMPTY at recall
	// time. Recall must still resolve the (deployment, stack) key from the PARSED request's workflow,
	// or cross-session learnings for a repeat (deployment, stack) op never surface.
	test("recalls using the workflow-derived stack when proposedFiles is empty (pre-draft)", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		let filterSeen: Record<string, string> | undefined;
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {},
			async addMessages() {},
			async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
				filterSeen = opts?.annotations;
				return [
					{
						text: "Bound metrics-custom on eu-b2b cluster-defaults; CI passed.",
						score: 0.9,
						annotations: { workflow: "cluster-default-edit", outcome: "applied" },
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
			// biome-ignore lint/suspicious/noExplicitAny: SIO-985 - test stub for the AgentMemoryClient surface
		} as any);
		// The exact repeat-op scenario: cluster-default-edit on eu-b2b, BEFORE draftChange (no files yet).
		const result = await memoryEnrichIac(
			iacState({
				proposedFiles: [],
				iacRequest: { workflow: "cluster-default-edit", isProd: false, cluster: "eu-b2b" },
			}),
		);
		// The recall filter is the SAME key the write path produces post-draft.
		expect(filterSeen).toEqual({ stack_instance: "eu-b2b/cluster-defaults", kind: "iac-change" });
		expect(result.priorLearnings).toContain("Bound metrics-custom");
		expect(result.priorLearnings).toContain("[cluster-default-edit applied]");
	});
});

// SIO-985: the verified inverse of stackFromPaths -- so the recall key (derived from the workflow,
// pre-draft) equals the write key (derived from proposedFiles, post-draft).
describe("stackForWorkflow (SIO-985)", () => {
	test("maps each workflow to the stack its proposer writes under", () => {
		expect(stackForWorkflow("cluster-default-edit")).toBe("cluster-defaults");
		expect(stackForWorkflow("ilm-rollout")).toBe("lifecycle-policies");
		expect(stackForWorkflow("slo-edit")).toBe("slos");
		expect(stackForWorkflow("alerting-edit")).toBe("alerting");
		expect(stackForWorkflow("dataview-edit")).toBe("dataviews");
		expect(stackForWorkflow("space-edit")).toBe("spaces");
		expect(stackForWorkflow("security-edit")).toBe("security");
		expect(stackForWorkflow("dashboard-edit")).toBe("dashboards");
		expect(stackForWorkflow("index-template-create")).toBe("index-templates");
		expect(stackForWorkflow("ingest-pipeline-create")).toBe("ingest-pipelines");
		expect(stackForWorkflow("fleet-integration")).toBe("fleet-integrations");
	});

	test("deployment-level workflows map to the 'deployments' stack (matches stackFromPaths)", () => {
		// These edit environments/_deployments/<cluster>.json, which stackFromPaths maps to "deployments".
		expect(stackForWorkflow("version-upgrade")).toBe("deployments");
		expect(stackForWorkflow("tier-resize")).toBe("deployments");
		expect(stackForWorkflow("topology-edit")).toBe("deployments");
		expect(stackFromPaths(["environments/_deployments/eu-b2b.json"])).toBe("deployments");
	});

	test("agrees with stackFromPaths for a representative stack-level path", () => {
		// The write key (file-derived) and the recall key (workflow-derived) must be identical.
		expect(stackForWorkflow("cluster-default-edit")).toBe(
			stackFromPaths(["environments/eu-b2b/cluster-defaults/metrics.json"]),
		);
		expect(stackForWorkflow("ilm-rollout")).toBe(
			stackFromPaths(["environments/eu-b2b/lifecycle-policies/metrics.json"]),
		);
	});

	test("'other' (no proposer) and undefined resolve to no stack", () => {
		expect(stackForWorkflow("other")).toBe("");
		expect(stackForWorkflow(undefined)).toBe("");
	});
});

// SIO-965: pipeline + terminal-outcome writer node.
describe("recordIacOutcome", () => {
	test("is a no-op when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const result = await recordIacOutcome(iacState({ pipelineId: 148, pipelineStatus: "success" }));
		expect(result).toEqual({});
		expect(store.calls).toEqual([]);
	});

	test("records the pipeline and promotes a successful change to applied", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordIacOutcome(iacState({ pipelineId: 148, pipelineStatus: "success" }));
		expect(store.calls.some((c) => c.cypher.includes("MERGE (pl:Pipeline") && c.params?.id === "148")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("RAN"))).toBe(true);
		const set = store.calls.find((c) => c.cypher.includes("SET c.outcome"));
		expect(set?.params?.outcome).toBe("applied");
	});

	test("maps a rejected review to rejected and a failed pipeline to failed", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const rejected = new InMemoryGraphStore();
		_setGraphStoreForTesting(rejected);
		await recordIacOutcome(iacState({ reviewDecision: "rejected" }));
		expect(rejected.calls.find((c) => c.cypher.includes("SET c.outcome"))?.params?.outcome).toBe("rejected");

		const failed = new InMemoryGraphStore();
		_setGraphStoreForTesting(failed);
		await recordIacOutcome(iacState({ pipelineId: 9, pipelineStatus: "failed" }));
		expect(failed.calls.find((c) => c.cypher.includes("SET c.outcome"))?.params?.outcome).toBe("failed");
	});

	test("soft-fails to {} when the store throws", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.run = async () => {
			throw new Error("graph down");
		};
		_setGraphStoreForTesting(store);
		const result = await recordIacOutcome(iacState({ pipelineId: 1, pipelineStatus: "success" }));
		expect(result).toEqual({});
	});
});

describe("stackFromPaths", () => {
	test("derives the stack from environments/<dep>/<stack>/ paths", () => {
		expect(stackFromPaths(["environments/eu-cld/slos/latency.json"])).toBe("slos");
		expect(stackFromPaths(["environments/eu-b2b/lifecycle-policies/metrics.json"])).toBe("lifecycle-policies");
	});
	test("maps environments/_deployments/<cluster>.json to the deployments stack", () => {
		expect(stackFromPaths(["environments/_deployments/eu-cld.json"])).toBe("deployments");
	});
	test("returns '' for paths outside the known layout", () => {
		expect(stackFromPaths(["modules/slo/main.tf"])).toBe("");
		expect(stackFromPaths([])).toBe("");
	});
});
