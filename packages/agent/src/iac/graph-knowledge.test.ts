// agent/src/iac/graph-knowledge.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import { graphEnrichIac, recordIacEntities, recordIacOutcome } from "./graph-knowledge.ts";
import { stackFromPaths } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const prev = process.env.KNOWLEDGE_GRAPH_ENABLED;

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
	_setGraphStoreForTesting(null);
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
