// agent/src/iac/graph-knowledge.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import { graphEnrichIac, recordIacEntities } from "./graph-knowledge.ts";
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
