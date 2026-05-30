// knowledge-graph/src/knowledge-graph.test.ts
import { describe, expect, test } from "bun:test";
import {
	buildGraphContext,
	EMBEDDING_DIM,
	InMemoryGraphStore,
	isKnowledgeGraphEnabled,
	linkCorrelation,
	linkResolution,
	MIGRATIONS,
	priorRelationshipsForServices,
	recordIncident,
	similarIncidents,
	upsertEntities,
} from "./index.ts";

describe("schema", () => {
	test("MIGRATIONS are idempotent node/rel DDL", () => {
		expect(MIGRATIONS.length).toBeGreaterThan(0);
		expect(MIGRATIONS.every((m) => m.includes("IF NOT EXISTS"))).toBe(true);
		expect(MIGRATIONS.some((m) => m.startsWith("CREATE NODE TABLE"))).toBe(true);
		expect(MIGRATIONS.some((m) => m.startsWith("CREATE REL TABLE"))).toBe(true);
		// embedding column dimension matches the Titan v2 constant
		expect(MIGRATIONS.some((m) => m.includes(`DOUBLE[${EMBEDDING_DIM}]`))).toBe(true);
	});
});

describe("isKnowledgeGraphEnabled", () => {
	test("respects the env flag", () => {
		expect(isKnowledgeGraphEnabled({} as NodeJS.ProcessEnv)).toBe(false);
		expect(isKnowledgeGraphEnabled({ KNOWLEDGE_GRAPH_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isKnowledgeGraphEnabled({ KNOWLEDGE_GRAPH_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
	});
});

describe("writer (parameterized, injection-safe)", () => {
	test("upsertEntities merges nodes and dependency edges with bound params", async () => {
		const store = new InMemoryGraphStore();
		await upsertEntities(store, {
			services: ["svc-a"],
			kafkaTopics: ["orders"],
			dependencies: [{ from: "svc-a", to: "svc-b" }],
		});
		// every call binds values via params; the cypher never contains the value
		const malicious = store.calls.find((c) => c.cypher.includes("DROP"));
		expect(malicious).toBeUndefined();
		expect(store.calls.some((c) => c.cypher.includes("MERGE (n:Service") && c.params?.value === "svc-a")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (n:KafkaTopic") && c.params?.value === "orders")).toBe(
			true,
		);
		expect(
			store.calls.some(
				(c) => c.cypher.includes("DEPENDS_ON") && c.params?.from === "svc-a" && c.params?.to === "svc-b",
			),
		).toBe(true);
	});

	test("a service name with Cypher metacharacters is bound, never interpolated", async () => {
		const store = new InMemoryGraphStore();
		const evil = '"}) DETACH DELETE n //';
		await upsertEntities(store, { services: [evil] });
		const call = store.calls[0];
		expect(call?.cypher).toBe("MERGE (n:Service {name: $value})");
		expect(call?.params?.value).toBe(evil);
	});

	test("linkCorrelation creates both findings and the relationship with props", async () => {
		const store = new InMemoryGraphStore();
		await linkCorrelation(store, {
			findingA: "kafka:lag",
			findingB: "elastic:errors",
			ruleName: "kafka-significant-lag",
			confidence: 0.8,
		});
		const rel = store.calls.find((c) => c.cypher.includes("CORRELATES_WITH"));
		expect(rel?.params).toEqual({
			a: "kafka:lag",
			b: "elastic:errors",
			rule: "kafka-significant-lag",
			confidence: 0.8,
		});
	});

	test("recordIncident sets embedding only when provided", async () => {
		const store = new InMemoryGraphStore();
		await recordIncident(store, { id: "inc1", severity: "high", services: ["svc-a"], embedding: [0.1, 0.2] });
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (i:Incident"));
		expect(merge?.cypher).toContain("i.embedding = $embedding");
		expect(merge?.params?.embedding).toEqual([0.1, 0.2]);
		// AFFECTED_BY edge created
		expect(store.calls.some((c) => c.cypher.includes("AFFECTED_BY"))).toBe(true);
	});

	test("recordIncident omits embedding clause when absent", async () => {
		const store = new InMemoryGraphStore();
		await recordIncident(store, { id: "inc2" });
		const merge = store.calls.find((c) => c.cypher.includes("MERGE (i:Incident"));
		expect(merge?.cypher).not.toContain("embedding");
	});

	test("linkResolution links incident to runbooks", async () => {
		const store = new InMemoryGraphStore();
		await linkResolution(store, "inc1", ["kafka-consumer-lag.md"]);
		expect(
			store.calls.some((c) => c.cypher.includes("RESOLVED_BY") && c.params?.filename === "kafka-consumer-lag.md"),
		).toBe(true);
	});
});

describe("reader", () => {
	test("priorRelationshipsForServices maps rows to dependencies", async () => {
		const store = new InMemoryGraphStore();
		store.stub("DEPENDS_ON", [{ from: "svc-a", to: "svc-b" }]);
		const deps = await priorRelationshipsForServices(store, ["svc-a"]);
		expect(deps).toEqual([{ from: "svc-a", to: "svc-b" }]);
	});

	test("similarIncidents returns [] for an empty embedding without querying", async () => {
		const store = new InMemoryGraphStore();
		const result = await similarIncidents(store, []);
		expect(result).toEqual([]);
		expect(store.calls).toEqual([]);
	});

	test("buildGraphContext renders deps + similar incidents, empty when nothing", () => {
		expect(buildGraphContext([], [])).toBe("");
		const ctx = buildGraphContext(
			[{ from: "svc-a", to: "svc-b" }],
			[{ id: "inc1", summary: "kafka lag outage", severity: "high", distance: 0.1 }],
		);
		expect(ctx).toContain("## Knowledge Graph");
		expect(ctx).toContain("svc-a -> svc-b");
		expect(ctx).toContain("kafka lag outage");
	});
});

describe("InMemoryGraphStore", () => {
	test("init/close toggle initialized and record nothing", async () => {
		const store = new InMemoryGraphStore();
		await store.init();
		expect(store.initialized).toBe(true);
		await store.close();
		expect(store.initialized).toBe(false);
	});
});
