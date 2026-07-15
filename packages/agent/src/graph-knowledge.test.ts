// agent/src/graph-knowledge.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, type GraphRow, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import { HumanMessage } from "@langchain/core/messages";
import { _setEmbedderForTesting, graphEnrich, recordGraphEntities, recordRootCauseData } from "./graph-knowledge.ts";
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

// SIO-1026: a state where the kafka-significant-lag rule fires AND is already
// covered by elastic findings referencing the same group id -> a satisfied,
// covered correlation the root-cause node persists.
function stateWithCoveredCorrelation(): AgentStateType {
	return {
		messages: [new HumanMessage("kafka lag outage")],
		requestId: "req-1",
		confidenceScore: 0.72,
		normalizedIncident: { severity: "high", affectedServices: [{ name: "orders" }] },
		dataSourceResults: [
			{
				dataSourceId: "kafka",
				status: "success",
				kafkaFindings: { consumerGroups: [{ id: "grp-1", state: "STABLE", totalLag: 20_000 }] },
			},
			// elastic findings referencing grp-1 make the rule "already covered".
			{ dataSourceId: "elastic", status: "success", data: { services: [{ name: "grp-1" }] } },
		],
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

	test("produces graphContext from dependencies + similar incidents (with prior root cause) when enabled", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("-[r:DEPENDS_ON]->", [{ from: "svc-a", to: "svc-b" }]);
		store.stub("QUERY_VECTOR_INDEX", [{ id: "inc9", summary: "prior kafka outage", severity: "high", distance: 0.1 }]);
		// SIO-1026: the similar incident has a recorded root cause.
		store.stub("[r:HAS_ROOT_CAUSE]", [
			{
				id: "rc1",
				class: "kafka-significant-lag",
				description: "consumer lag > 10K",
				confidence: 0.7,
				ruleName: "kafka-significant-lag",
			},
		]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);

		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag again"));
		expect(result.graphContext).toContain("## Knowledge Graph");
		expect(result.graphContext).toContain("svc-a -> svc-b");
		expect(result.graphContext).toContain("prior kafka outage");
		expect(result.graphContext).toContain("prior root cause: consumer lag > 10K");
	});

	// SIO-1104 (5b): the priorRootCauses graph join surfaces "what resolved it".
	test("annotates similar incidents with the runbooks that resolved the prior cause class", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("QUERY_VECTOR_INDEX", [{ id: "inc9", summary: "prior kafka outage", severity: "high", distance: 0.1 }]);
		store.stub("[r:HAS_ROOT_CAUSE]", [
			{
				id: "rc1",
				class: "kafka-significant-lag",
				description: "consumer lag > 10K",
				confidence: 0.7,
				ruleName: "kafka-significant-lag",
			},
		]);
		// priorRootCauses fans out one row per runbook; duplicate runbooks dedupe.
		store.stub("RootCause {class:", [
			{
				incidentId: "inc9",
				summary: "prior kafka outage",
				severity: "high",
				description: "consumer lag > 10K",
				runbook: "kafka-consumer-lag.md",
				createdAt: "2026-07-01T00:00:00Z",
			},
			{
				incidentId: "inc9",
				summary: "prior kafka outage",
				severity: "high",
				description: "consumer lag > 10K",
				runbook: "kafka-broker-health.md",
				createdAt: "2026-07-01T00:00:00Z",
			},
			{
				incidentId: "inc4",
				summary: "older lag incident",
				severity: "medium",
				description: "consumer lag > 10K",
				runbook: "kafka-consumer-lag.md",
				createdAt: "2026-06-01T00:00:00Z",
			},
		]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);

		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag again"));
		expect(result.graphContext).toContain("resolved by kafka-consumer-lag.md, kafka-broker-health.md");
		// the priorRootCauses lookup was keyed on the recorded cause class
		expect(
			store.calls.some((c) => c.cypher.includes("RootCause {class:") && c.params?.class === "kafka-significant-lag"),
		).toBe(true);
	});

	test("renders the similar-incident line unchanged when no runbook resolved the prior cause", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("QUERY_VECTOR_INDEX", [{ id: "inc9", summary: "prior kafka outage", severity: "high", distance: 0.1 }]);
		store.stub("[r:HAS_ROOT_CAUSE]", [
			{
				id: "rc1",
				class: "kafka-significant-lag",
				description: "consumer lag > 10K",
				confidence: 0.7,
				ruleName: "kafka-significant-lag",
			},
		]);
		store.stub("RootCause {class:", [
			{
				incidentId: "inc9",
				summary: "prior kafka outage",
				severity: "high",
				description: "consumer lag > 10K",
				runbook: null,
				createdAt: "2026-07-01T00:00:00Z",
			},
		]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);

		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag again"));
		expect(result.graphContext).toContain("prior root cause: consumer lag > 10K");
		expect(result.graphContext).not.toContain("resolved by");
	});

	test("keeps the root-cause annotation when the runbook join throws (soft-fail)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		class ThrowOnPriorCauses extends InMemoryGraphStore {
			override async run<T extends GraphRow = GraphRow>(
				cypher: string,
				params?: Record<string, unknown>,
			): Promise<T[]> {
				if (cypher.includes("RootCause {class:")) throw new Error("binder exploded");
				return super.run(cypher, params);
			}
		}
		const store = new ThrowOnPriorCauses();
		store.stub("QUERY_VECTOR_INDEX", [{ id: "inc9", summary: "prior kafka outage", severity: "high", distance: 0.1 }]);
		store.stub("[r:HAS_ROOT_CAUSE]", [
			{
				id: "rc1",
				class: "kafka-significant-lag",
				description: "consumer lag > 10K",
				confidence: 0.7,
				ruleName: "kafka-significant-lag",
			},
		]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);

		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag again"));
		expect(result.graphContext).toContain("prior root cause: consumer lag > 10K");
		expect(result.graphContext).not.toContain("resolved by");
	});

	// SIO-1103: graphEnrich populates graphBlastRadius for the sync correlation rule.
	test("populates graphBlastRadius from shared-infra neighbours", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		// blastRadiusForServices runs DEPENDS_ON (undirected) + PRODUCES_TO + OBSERVED_IN.
		store.stub("PRODUCES_TO", [{ n: "refunds", t: "events" }]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);
		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag"));
		expect(result.graphBlastRadius).toContainEqual({
			service: "svc-a",
			neighbour: "refunds",
			via: "kafka-topic",
			sharedResource: "events",
		});
	});

	test("soft-fails to dependencies-only when the embedder throws", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("-[r:DEPENDS_ON]->", [{ from: "svc-a", to: "svc-b" }]);
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

describe("recordRootCauseData", () => {
	test("is a no-op when the graph is disabled", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const result = await recordRootCauseData(stateWithCoveredCorrelation());
		expect(result).toEqual({});
		expect(store.calls).toEqual([]);
	});

	test("records nothing when no correlation fired (honest null, not fabricated)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		// stateWith has no dataSourceResults -> every rule is trivially satisfied
		// (trigger absent), never "already covered".
		const state = { ...stateWith(["svc-a"], "hello"), dataSourceResults: [] } as unknown as AgentStateType;
		const result = await recordRootCauseData(state);
		expect(result).toEqual({});
		expect(store.calls).toEqual([]);
	});

	test("writes a RootCause + HAS_ROOT_CAUSE when a covered correlation held", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		await recordRootCauseData(stateWithCoveredCorrelation());
		const node = store.calls.find((c) => c.cypher.includes("MERGE (rc:RootCause"));
		expect(node?.params?.class).toBe("kafka-significant-lag");
		// confidence is per-incident -> lives on the edge, not the shared node.
		const edge = store.calls.find((c) => c.cypher.includes("MERGE (i)-[r:HAS_ROOT_CAUSE]"));
		expect(edge?.params?.incidentId).toBe("req-1");
		expect(edge?.params?.ruleName).toBe("kafka-significant-lag");
		expect(edge?.params?.confidence).toBe(0.72);
	});
});
