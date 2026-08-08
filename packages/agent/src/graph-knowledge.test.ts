// agent/src/graph-knowledge.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	_setGraphStoreFactoryForTesting,
	_setGraphStoreForTesting,
	type GraphRow,
	InMemoryGraphStore,
} from "@devops-agent/knowledge-graph";
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
	_setGraphStoreFactoryForTesting(undefined);
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
		// SIO-1134: enrichment is curated-only -- the fixture incident carries a ticketKey.
		store.stub("QUERY_VECTOR_INDEX", [
			{ id: "inc9", summary: "prior kafka outage", severity: "high", distance: 0.1, ticketKey: "DEVOPS-1355" },
		]);
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

	test("SIO-1134: uncurated incidents (no ticketKey) are excluded from graphContext", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("QUERY_VECTOR_INDEX", [
			{ id: "inc9", summary: "curated kafka outage", severity: "high", distance: 0.1, ticketKey: "DEVOPS-1355" },
			{ id: "inc10", summary: "uncurated noise run", severity: "low", distance: 0.2, ticketKey: "" },
			{ id: "inc11", summary: "legacy row without key", severity: "low", distance: 0.3 },
		]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);

		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag again"));
		expect(result.graphContext).toContain("curated kafka outage");
		expect(result.graphContext).not.toContain("uncurated noise run");
		expect(result.graphContext).not.toContain("legacy row without key");
	});

	// SIO-1104 (5b): the priorRootCauses graph join surfaces "what resolved it".
	test("annotates similar incidents with the runbooks that resolved the prior cause class", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		// SIO-1134: enrichment is curated-only -- the fixture incident carries a ticketKey.
		store.stub("QUERY_VECTOR_INDEX", [
			{ id: "inc9", summary: "prior kafka outage", severity: "high", distance: 0.1, ticketKey: "DEVOPS-1355" },
		]);
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
		// SIO-1134: enrichment is curated-only -- the fixture incident carries a ticketKey.
		store.stub("QUERY_VECTOR_INDEX", [
			{ id: "inc9", summary: "prior kafka outage", severity: "high", distance: 0.1, ticketKey: "DEVOPS-1355" },
		]);
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
		// SIO-1134: enrichment is curated-only -- the fixture incident carries a ticketKey.
		store.stub("QUERY_VECTOR_INDEX", [
			{ id: "inc9", summary: "prior kafka outage", severity: "high", distance: 0.1, ticketKey: "DEVOPS-1355" },
		]);
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

	// SIO-1305: the full canonical Service-name universe, read once here so the
	// aggregator's synchronous downstream-impact render can resolve Orbit
	// consumer repos against the same universe the write path (recordRootCauseData)
	// uses -- not just names already surfaced in this turn's graphBlastRadius.
	test("populates knownServiceNames from a live serviceNames(store) read", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("MATCH (s:Service) RETURN s.name", [{ name: "styles-v3-service" }, { name: "lists-api" }]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);
		const result = await graphEnrich(stateWith(["styles-v3-service"], "kafka lag"));
		expect(result.knownServiceNames).toEqual(["styles-v3-service", "lists-api"]);
	});

	test("knownServiceNames read failure is non-fatal (soft-fails to empty, keeps the rest of enrichment)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		const originalRun = store.run.bind(store);
		store.run = (async (cypher: string, params?: Record<string, unknown>) => {
			if (cypher.includes("MATCH (s:Service) RETURN s.name")) throw new Error("boom");
			return originalRun(cypher, params);
		}) as typeof store.run;
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);
		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag"));
		expect(result.knownServiceNames).toEqual([]);
		// the rest of enrichment still ran (graphContext key is present).
		expect(result.graphContext).toBeDefined();
	});

	// CodeRabbit (PR #547, round 3): knownServiceNames uses a REPLACE reducer, so
	// an update that OMITS the key leaves a prior turn's value untouched. The
	// outer catch (getGraphStore() itself throwing, before either inner
	// try/catch runs) must explicitly return knownServiceNames: [], or a stale
	// service list from an earlier successful turn would silently leak forward.
	test("outer-catch failure (getGraphStore itself throws) explicitly clears knownServiceNames", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		_setGraphStoreFactoryForTesting(() => Promise.reject(new Error("store open failed")));
		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag"));
		// SIO-1457: applicationTopologyOverlay is a REPLACE-reducer slot with the
		// same stale-value hazard, so the outer catch clears it too.
		expect(result).toEqual({ knownServiceNames: [], applicationTopologyOverlay: [] });
	});

	// SIO-1457: the overlay read converts AppMapEdge rows into ApplicationTopologyEdge
	// values via the shared id-prefix contract; the collector stamp rides `detail`.
	test("populates applicationTopologyOverlay from KG app-map edges", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("-[r:DEPENDS_ON]->", [{ from: "svc-a", to: "svc-b", discoveredBy: "orbit-name-match" }]);
		store.stub("-[r:RUNS_ON]->", [{ arn: "arn:aws:ecs:eu-west-1:1:service/prod/svc-a", discoveredBy: "topology-job" }]);
		store.stub("-[r:CONSUMES_FROM]->", [{ group: "svc-a-workers", topic: "orders", discoveredBy: "topology-job" }]);
		_setGraphStoreForTesting(store);
		_setEmbedderForTesting(async () => [0.1, 0.2, 0.3]);

		const result = await graphEnrich(stateWith(["svc-a"], "kafka lag"));
		const overlay = result.applicationTopologyOverlay ?? [];
		expect(overlay).toContainEqual({
			from: "svc:svc-a",
			to: "svc:svc-b",
			kind: "calls",
			detail: "orbit-name-match",
		});
		expect(overlay).toContainEqual({
			from: "svc:svc-a",
			to: "aws:arn:aws:ecs:eu-west-1:1:service/prod/svc-a",
			kind: "runs-on",
			detail: "topology-job",
		});
		expect(overlay).toContainEqual({
			from: "cg:svc-a-workers",
			to: "topic:orders",
			kind: "consumes",
			detail: "topology-job",
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

	// SIO-1305: the Orbit consumer-edge write is INDEPENDENT of whether a root
	// cause was found -- it must fire even when topSatisfiedCorrelation returns
	// null, since Orbit findings are unrelated to correlation-rule coverage.
	test("writes Orbit name-match consumer edges even when no correlation fired", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("MATCH (s:Service) RETURN s.name", [{ name: "styles-v3-service" }, { name: "lists-api" }]);
		_setGraphStoreForTesting(store);
		const state = {
			...stateWith(["styles-v3-service"], "hello"),
			dataSourceResults: [
				{
					dataSourceId: "gitlab",
					status: "success",
					orbitFindings: {
						blastRadius: [
							{
								definitionName: "getStyleByStyleCode",
								sourceProject: "pvhcorp/styles-v3-service",
								importedByProjects: [],
								importedByFiles: [],
								importSiteCount: 0,
								radiusMode: "definition-name-match",
							},
							{
								definitionName: "getStyleByStyleCode",
								sourceProject: "pvhcorp/lists-api",
								importedByProjects: [],
								importedByFiles: [],
								importSiteCount: 0,
								radiusMode: "definition-name-match",
							},
						],
					},
				},
			],
		} as unknown as AgentStateType;
		const result = await recordRootCauseData(state);
		expect(result).toEqual({});
		// No RootCause written (no correlation fired)...
		expect(store.calls.some((c) => c.cypher.includes("MERGE (rc:RootCause"))).toBe(false);
		// ...but the Orbit DEPENDS_ON edge WAS written.
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (a)-[r:DEPENDS_ON]->(b)"));
		expect(merge?.params?.from).toBe("lists-api");
		expect(merge?.params?.to).toBe("styles-v3-service");
		expect(merge?.params?.orbitDiscoveredBy).toBe("orbit-name-match");
	});

	test("does not write Orbit edges when orbitFindings has no name-match rows", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const state = { ...stateWith(["svc-a"], "hello"), dataSourceResults: [] } as unknown as AgentStateType;
		await recordRootCauseData(state);
		expect(store.calls.some((c) => c.cypher.includes("DEPENDS_ON"))).toBe(false);
	});
});
