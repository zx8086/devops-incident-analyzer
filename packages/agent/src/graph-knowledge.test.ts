// agent/src/graph-knowledge.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import { HumanMessage } from "@langchain/core/messages";
import { _setEmbedderForTesting, graphEnrich, recordGraphEntities } from "./graph-knowledge.ts";
import type { AgentStateType } from "./state.ts";

const prev = process.env.KNOWLEDGE_GRAPH_ENABLED;

function stateWith(services: string[], query: string): AgentStateType {
	return {
		messages: [new HumanMessage(query)],
		requestId: "req-1",
		normalizedIncident: { severity: "high", affectedServices: services.map((name) => ({ name })) },
		extractedEntities: { dataSources: [] },
	} as unknown as AgentStateType;
}

beforeEach(() => {
	_setGraphStoreForTesting(null);
	_setEmbedderForTesting(null);
});

afterEach(() => {
	if (prev === undefined) delete process.env.KNOWLEDGE_GRAPH_ENABLED;
	else process.env.KNOWLEDGE_GRAPH_ENABLED = prev;
	_setGraphStoreForTesting(null);
	_setEmbedderForTesting(null);
});

describe("recordGraphEntities", () => {
	test("is a no-op when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const result = await recordGraphEntities(stateWith(["svc-a"], "kafka lag"));
		expect(result).toEqual({});
		expect(store.calls).toEqual([]);
	});

	test("writes services + incident when enabled", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordGraphEntities(stateWith(["svc-a"], "kafka lag outage"));
		expect(store.calls.some((c) => c.cypher.includes("MERGE (n:Service") && c.params?.value === "svc-a")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (i:Incident") && c.params?.id === "req-1")).toBe(true);
	});
});

describe("graphEnrich", () => {
	test("is a no-op when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag"));
		expect(result).toEqual({});
	});

	test("produces graphContext from dependencies + similar incidents when enabled", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("-[:DEPENDS_ON]->", [{ from: "svc-a", to: "svc-b" }]);
		store.stub("QUERY_VECTOR_INDEX", [{ id: "inc9", summary: "prior kafka outage", severity: "high", distance: 0.1 }]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);

		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag again"));
		expect(result.graphContext).toContain("## Knowledge Graph");
		expect(result.graphContext).toContain("svc-a -> svc-b");
		expect(result.graphContext).toContain("prior kafka outage");
	});

	test("soft-fails to dependencies-only when the embedder throws", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("-[:DEPENDS_ON]->", [{ from: "svc-a", to: "svc-b" }]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => {
			throw new Error("bedrock down");
		});

		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag"));
		expect(result.graphContext).toContain("svc-a -> svc-b");
		// no similar-incidents section because the embedding failed
		expect(result.graphContext).not.toContain("Similar prior incidents");
	});
});
