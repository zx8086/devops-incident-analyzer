// packages/agent/src/kg-topology.test.ts

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
// Preserve the REAL module (esp. the ALS wrappers withAwsEstate/withElasticDeployment)
// and override ONLY the tool/connection lookups. Spreading the real exports avoids the
// bun mock.module cross-file leak (reference_bun_mock_namespace_live_binding_poisoning).
import * as realBridge from "./mcp-bridge.ts";

type StubTool = { name: string; invoke: (args: unknown) => Promise<unknown> };
let toolRegistry: Record<string, StubTool[]> = {};
let connectedServers: string[] = [];

mock.module("./mcp-bridge.ts", () => ({
	...realBridge,
	getToolsForDataSource: (dataSourceId: string) => toolRegistry[dataSourceId] ?? [],
	getConnectedServers: () => connectedServers,
}));

import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import { _resetEstateCacheForTests, _resetEstateReconcileForTests } from "./aws-estate-router.ts";
import {
	collectElasticDependencies,
	configuredElasticDeployments,
	runTopologySweep,
	topologyCronEnabled,
	topologyMissThreshold,
} from "./kg-topology.ts";

const ORIG_ENV = {
	KNOWLEDGE_GRAPH_ENABLED: process.env.KNOWLEDGE_GRAPH_ENABLED,
	KG_TOPOLOGY_CRON_ENABLED: process.env.KG_TOPOLOGY_CRON_ENABLED,
	AWS_ESTATES: process.env.AWS_ESTATES,
	ELASTIC_DEPLOYMENTS: process.env.ELASTIC_DEPLOYMENTS,
	// SIO-1115: page cap + kafka describe timeout, set by individual tests.
	KG_TOPOLOGY_MAX_PAGES: process.env.KG_TOPOLOGY_MAX_PAGES,
	KG_TOPOLOGY_KAFKA_DESCRIBE_TIMEOUT_MS: process.env.KG_TOPOLOGY_KAFKA_DESCRIBE_TIMEOUT_MS,
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(ORIG_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

// SIO-1115: composite-agg page. flatten service->destinations into flat {svc,dest}
// buckets. `afterKey` present => not the last page (the collector keeps paging); a
// service with no destinations still emits one bucket with dest=null (the missing_bucket
// result) so it lands in `services` for the P6 self-join. Omit afterKey for a terminal page.
function apmCompositePage(
	pairs: Array<{ service: string; destinations: string[] }>,
	afterKey?: Record<string, unknown>,
): string {
	const buckets: Array<{ key: { svc: string; dest: string | null }; doc_count: number }> = [];
	for (const p of pairs) {
		if (p.destinations.length === 0) buckets.push({ key: { svc: p.service, dest: null }, doc_count: 1 });
		for (const d of p.destinations) buckets.push({ key: { svc: p.service, dest: d }, doc_count: 1 });
	}
	return `Search results with aggregations (100 total hits, 5ms):\n\n${JSON.stringify({
		svc_dest: { ...(afterKey ? { after_key: afterKey } : {}), buckets },
	})}`;
}

// An empty composite page terminates the collector's pagination loop.
function apmEmptyPage(): string {
	return `Search results with aggregations (0 total hits, 1ms):\n\n${JSON.stringify({ svc_dest: { buckets: [] } })}`;
}

beforeEach(() => {
	process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
	process.env.KG_TOPOLOGY_CRON_ENABLED = "true";
	delete process.env.AWS_ESTATES;
	delete process.env.ELASTIC_DEPLOYMENTS;
	delete process.env.KG_TOPOLOGY_MAX_PAGES;
	delete process.env.KG_TOPOLOGY_KAFKA_DESCRIBE_TIMEOUT_MS;
	toolRegistry = {};
	connectedServers = [];
	_setGraphStoreForTesting(null);
	_resetEstateCacheForTests();
	_resetEstateReconcileForTests();
});

afterEach(() => {
	restoreEnv();
	_setGraphStoreForTesting(null);
	_resetEstateCacheForTests();
	_resetEstateReconcileForTests();
});

afterAll(() => {
	mock.module("./mcp-bridge.ts", () => ({ ...realBridge }));
});

describe("flags", () => {
	test("topologyCronEnabled defaults OFF and requires BOTH flags", () => {
		expect(topologyCronEnabled({} as NodeJS.ProcessEnv)).toBe(false);
		expect(topologyCronEnabled({ KNOWLEDGE_GRAPH_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
		expect(topologyCronEnabled({ KG_TOPOLOGY_CRON_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
		expect(
			topologyCronEnabled({ KG_TOPOLOGY_CRON_ENABLED: "true", KNOWLEDGE_GRAPH_ENABLED: "true" } as NodeJS.ProcessEnv),
		).toBe(true);
		expect(
			topologyCronEnabled({ KG_TOPOLOGY_CRON_ENABLED: "1", KNOWLEDGE_GRAPH_ENABLED: "1" } as NodeJS.ProcessEnv),
		).toBe(true);
	});

	test("topologyMissThreshold parses a positive integer, else 3", () => {
		expect(topologyMissThreshold({} as NodeJS.ProcessEnv)).toBe(3);
		expect(topologyMissThreshold({ KG_TOPOLOGY_MISS_THRESHOLD: "5" } as NodeJS.ProcessEnv)).toBe(5);
		expect(topologyMissThreshold({ KG_TOPOLOGY_MISS_THRESHOLD: "0" } as NodeJS.ProcessEnv)).toBe(3);
		expect(topologyMissThreshold({ KG_TOPOLOGY_MISS_THRESHOLD: "nope" } as NodeJS.ProcessEnv)).toBe(3);
	});

	test("configuredElasticDeployments splits the comma list, [undefined] when unset", () => {
		expect(configuredElasticDeployments({} as NodeJS.ProcessEnv)).toEqual([undefined]);
		expect(configuredElasticDeployments({ ELASTIC_DEPLOYMENTS: "prod, staging" } as NodeJS.ProcessEnv)).toEqual([
			"prod",
			"staging",
		]);
	});
});

describe("collectElasticDependencies", () => {
	test("keeps only destinations that map to another observed service (P6), port-stripped", async () => {
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async () =>
					apmCompositePage([
						{ service: "order-service", destinations: ["payment-service:443", "postgresql", "unknown-thing"] },
						{ service: "payment-service", destinations: ["order-service"] },
					]),
			},
		];
		const result = await collectElasticDependencies();
		expect(result.complete).toBe(true);
		expect(result.edges).toContainEqual({ kind: "depends-on", from: "order-service", to: "payment-service" });
		expect(result.edges).toContainEqual({ kind: "depends-on", from: "payment-service", to: "order-service" });
		// postgresql / unknown-thing are not observed services -> dropped
		expect(result.edges).toHaveLength(2);
		expect(result.callers.sort()).toEqual(["order-service", "payment-service"]);
	});

	test("incomplete without the search tool", async () => {
		const result = await collectElasticDependencies();
		expect(result).toMatchObject({ edges: [], complete: false });
	});
});

describe("runTopologySweep", () => {
	test("skips when disabled", async () => {
		delete process.env.KG_TOPOLOGY_CRON_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		expect(await runTopologySweep()).toEqual({ skipped: "disabled", sources: {} });
		expect(store.calls).toEqual([]);
	});

	test("skips (and touches nothing) until the mcp bridge is connected", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = [];
		expect(await runTopologySweep()).toEqual({ skipped: "bridge-not-connected", sources: {} });
		expect(store.calls).toEqual([]);
	});

	test("writes edges per source, sweeps only complete collections, isolates failures", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["elastic-mcp", "konnect-mcp", "kafka-mcp", "aws-mcp"];
		process.env.AWS_ESTATES = JSON.stringify({ prod: {} });

		let kafkaListArgs: unknown;
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async () =>
					apmCompositePage([
						{ service: "order-service", destinations: ["payment-service"] },
						{ service: "payment-service", destinations: [] },
					]),
			},
		];
		// konnect: routes listing is CAPPED -> edges written, sweep skipped
		toolRegistry.konnect = [
			{
				name: "konnect_list_control_planes",
				invoke: async () => JSON.stringify({ controlPlanes: [{ controlPlaneId: "cp1", name: "prod-cp" }] }),
			},
			{
				name: "konnect_list_services",
				invoke: async () => JSON.stringify({ services: [{ serviceId: "s1", name: "order-service" }] }),
			},
			{
				name: "konnect_list_routes",
				invoke: async () =>
					JSON.stringify({
						metadata: { capped: true },
						routes: [{ routeId: "r1", paths: ["/api/orders"], serviceId: "s1" }],
					}),
			},
		];
		// kafka: list succeeds (args captured), describe THROWS -> source incomplete
		toolRegistry.kafka = [
			{
				name: "kafka_list_consumer_groups",
				invoke: async (args) => {
					kafkaListArgs = args;
					return JSON.stringify([{ id: "orders-cg", state: "STABLE" }]);
				},
			},
			{
				name: "kafka_describe_consumer_group",
				invoke: async () => {
					throw new Error("broker down");
				},
			},
		];
		// aws: ECS enumeration succeeds; order-service matches a known service
		toolRegistry.aws = [
			{
				name: "aws_ecs_list_clusters",
				invoke: async () => JSON.stringify({ clusterArns: ["arn:aws:ecs:eu-west-1:1:cluster/prod"] }),
			},
			{
				name: "aws_ecs_list_services",
				invoke: async () => JSON.stringify({ serviceArns: ["arn:aws:ecs:eu-west-1:1:service/prod/order-service"] }),
			},
		];

		const summary = await runTopologySweep({ source: "test" });

		// elastic: complete -> edge written AND swept
		expect(summary.sources.elastic).toMatchObject({ edges: 1, invalidated: 0 });
		expect(summary.sources.elastic?.sweepSkipped).toBeUndefined();
		expect(
			store.calls.some((c) => c.cypher.includes("MERGE (a)-[r:DEPENDS_ON]->(b)") && c.params?.from === "order-service"),
		).toBe(true);
		// the elastic sweep ran its diff read
		expect(
			store.calls.some(
				(c) => c.cypher.includes("(a:Service)-[r:DEPENDS_ON]->(b:Service)") && c.cypher.includes("AS misses"),
			),
		).toBe(true);

		// konnect: capped -> edge written, NO sweep read for ROUTES_TO
		expect(summary.sources.konnect).toMatchObject({ edges: 1, sweepSkipped: true });
		expect(store.calls.some((c) => c.cypher.includes("MERGE (a)-[r:ROUTES_TO]->(b)"))).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("[r:ROUTES_TO]") && c.cypher.includes("AS misses"))).toBe(false);

		// kafka: describe failed -> zero edges, incomplete, but the source did not
		// break the sweep, and the group list was called with NO filter arg
		expect(summary.sources.kafka).toMatchObject({ edges: 0, sweepSkipped: true });
		expect((kafkaListArgs as Record<string, unknown>)?.filter).toBeUndefined();

		// aws: complete -> RUNS_ON edge for the matched service, swept
		expect(summary.sources.aws).toMatchObject({ edges: 1, invalidated: 0 });
		expect(
			store.calls.some(
				(c) =>
					c.cypher.includes("MERGE (a)-[r:RUNS_ON]->(b)") &&
					c.params?.to === "arn:aws:ecs:eu-west-1:1:service/prod/order-service",
			),
		).toBe(true);
	});

	// [CodeRabbit] malformed responses and paginated/truncated listings must never
	// count as a complete collection (they'd feed an authoritative empty/partial
	// set into the sweep and invalidate valid edges).
	test("a malformed kafka list response fails the source instead of reading as empty", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["kafka-mcp"];
		toolRegistry.kafka = [
			{ name: "kafka_list_consumer_groups", invoke: async () => "Error: broker unreachable (no JSON here)" },
			{ name: "kafka_describe_consumer_group", invoke: async () => JSON.stringify({ offsets: [] }) },
		];
		const summary = await runTopologySweep();
		expect(summary.sources.kafka?.error).toContain("unparseable");
		expect(summary.sources.kafka).toMatchObject({ edges: 0, sweepSkipped: true });
		// no sweep read happened for CONSUMES_FROM
		expect(store.calls.some((c) => c.cypher.includes("[r:CONSUMES_FROM]") && c.cypher.includes("AS misses"))).toBe(
			false,
		);
	});

	test("ECS paginates the service list across nextToken pages, then sweeps (SIO-1115)", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["aws-mcp"];
		process.env.AWS_ESTATES = JSON.stringify({ prod: {} });
		let servicesCall = 0;
		toolRegistry.aws = [
			{
				name: "aws_ecs_list_clusters",
				invoke: async () => JSON.stringify({ clusterArns: ["arn:aws:ecs:eu-west-1:1:cluster/prod"] }),
			},
			{
				name: "aws_ecs_list_services",
				invoke: async (args) => {
					servicesCall++;
					// page 1 carries a token; page 2 (called with { nextToken }) is the last.
					const hasToken = (args as { nextToken?: string }).nextToken;
					if (!hasToken) {
						return JSON.stringify({
							serviceArns: ["arn:aws:ecs:eu-west-1:1:service/prod/order-service"],
							nextToken: "page-2",
						});
					}
					return JSON.stringify({ serviceArns: ["arn:aws:ecs:eu-west-1:1:service/prod/payment-service"] });
				},
			},
		];
		store.stub("MATCH (s:Service) RETURN s.name", [{ name: "order-service" }, { name: "payment-service" }]);
		const summary = await runTopologySweep();
		expect(servicesCall).toBe(2); // both pages fetched
		// both pages' services became edges, and the collection is complete -> sweep ran
		expect(summary.sources.aws).toMatchObject({ edges: 2 });
		expect(summary.sources.aws?.sweepSkipped).toBeUndefined();
		expect(store.calls.some((c) => c.cypher.includes("[r:RUNS_ON]") && c.cypher.includes("AS misses"))).toBe(true);
	});

	test("ECS pagination hitting the page cap writes edges but skips the sweep (SIO-1115)", async () => {
		process.env.KG_TOPOLOGY_MAX_PAGES = "1"; // owned in ORIG_ENV save/restore
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["aws-mcp"];
		process.env.AWS_ESTATES = JSON.stringify({ prod: {} });
		toolRegistry.aws = [
			{
				name: "aws_ecs_list_clusters",
				invoke: async () => JSON.stringify({ clusterArns: ["arn:aws:ecs:eu-west-1:1:cluster/prod"] }),
			},
			{
				name: "aws_ecs_list_services",
				invoke: async () =>
					JSON.stringify({
						serviceArns: ["arn:aws:ecs:eu-west-1:1:service/prod/order-service"],
						nextToken: "never-ends", // always more pages -> cap binds at 1
					}),
			},
		];
		store.stub("MATCH (s:Service) RETURN s.name", [{ name: "order-service" }]);
		const summary = await runTopologySweep();
		expect(summary.sources.aws).toMatchObject({ edges: 1, sweepSkipped: true });
		expect(store.calls.some((c) => c.cypher.includes("[r:RUNS_ON]") && c.cypher.includes("AS misses"))).toBe(false);
	});

	test("APM composite agg pages to exhaustion, then sweeps (SIO-1115)", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["elastic-mcp"];
		let page = 0;
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async () => {
					page++;
					// page 1: a pair + an after_key -> keep paging. page 2: empty -> stop.
					if (page === 1) {
						return apmCompositePage(
							[
								{ service: "order-service", destinations: ["payment-service"] },
								{ service: "payment-service", destinations: [] },
							],
							{ svc: "payment-service", dest: "" },
						);
					}
					return apmEmptyPage();
				},
			},
		];
		const summary = await runTopologySweep();
		expect(page).toBe(2); // paged until the empty page
		expect(summary.sources.elastic).toMatchObject({ edges: 1 });
		expect(summary.sources.elastic?.sweepSkipped).toBeUndefined();
		expect(
			store.calls.some((c) => c.cypher.includes("(a:Service)-[r:DEPENDS_ON]") && c.cypher.includes("AS misses")),
		).toBe(true);
	});

	test("APM composite agg hitting the page cap writes edges but skips the sweep (SIO-1115)", async () => {
		process.env.KG_TOPOLOGY_MAX_PAGES = "1"; // owned in ORIG_ENV save/restore
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["elastic-mcp"];
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				// always a full page with an after_key -> cap binds at 1 page
				invoke: async () =>
					apmCompositePage(
						[
							{ service: "order-service", destinations: ["payment-service"] },
							{ service: "payment-service", destinations: [] },
						],
						{ svc: "payment-service", dest: "" },
					),
			},
		];
		const summary = await runTopologySweep();
		expect(summary.sources.elastic).toMatchObject({ edges: 1, sweepSkipped: true });
		expect(
			store.calls.some((c) => c.cypher.includes("(a:Service)-[r:DEPENDS_ON]") && c.cypher.includes("AS misses")),
		).toBe(false);
	});

	test("APM shape drift (valid JSON, no svc_dest agg) fails the source; no sweep (SIO-1115)", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["elastic-mcp"];
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				// a well-formed JSON envelope that is NOT an APM composite agg (drift / tool error).
				// Must NOT be read as a legitimately-empty page (that would retire valid edges).
				invoke: async () =>
					`Search results with aggregations (0 total hits, 1ms):\n\n${JSON.stringify({ error: "boom" })}`,
			},
		];
		const summary = await runTopologySweep();
		expect(summary.sources.elastic).toMatchObject({ edges: 0, sweepSkipped: true });
		expect(
			store.calls.some((c) => c.cypher.includes("(a:Service)-[r:DEPENDS_ON]") && c.cypher.includes("AS misses")),
		).toBe(false);
	});

	test("a source whose MCP server is not connected is skipped without touching the graph", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["kafka-mcp"];
		toolRegistry.kafka = [
			{ name: "kafka_list_consumer_groups", invoke: async () => JSON.stringify([]) },
			{ name: "kafka_describe_consumer_group", invoke: async () => JSON.stringify({ offsets: [] }) },
		];
		const summary = await runTopologySweep();
		expect(summary.sources.elastic).toMatchObject({ edges: 0, sweepSkipped: true, error: "server-not-connected" });
		expect(summary.sources.aws).toMatchObject({ error: "server-not-connected" });
		// kafka ran (empty but complete -> sweep read for CONSUMES_FROM happened)
		expect(summary.sources.kafka).toMatchObject({ edges: 0, invalidated: 0 });
		expect(store.calls.some((c) => c.cypher.includes("[r:CONSUMES_FROM]") && c.cypher.includes("AS misses"))).toBe(
			true,
		);
	});

	test("kafka describes all groups via the pool, then sweeps (SIO-1115)", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["kafka-mcp"];
		const describedGroups: string[] = [];
		toolRegistry.kafka = [
			{
				name: "kafka_list_consumer_groups",
				invoke: async () =>
					JSON.stringify([
						{ id: "cg-a", state: "STABLE" },
						{ id: "cg-b", state: "STABLE" },
						{ id: "cg-c", state: "STABLE" },
					]),
			},
			{
				name: "kafka_describe_consumer_group",
				invoke: async (args) => {
					const groupId = (args as { groupId: string }).groupId;
					describedGroups.push(groupId);
					return JSON.stringify({ offsets: [{ topic: `topic-${groupId}` }] });
				},
			},
		];
		const summary = await runTopologySweep();
		expect(describedGroups.sort()).toEqual(["cg-a", "cg-b", "cg-c"]); // all described
		expect(summary.sources.kafka).toMatchObject({ edges: 3 });
		expect(summary.sources.kafka?.sweepSkipped).toBeUndefined();
		expect(store.calls.some((c) => c.cypher.includes("[r:CONSUMES_FROM]") && c.cypher.includes("AS misses"))).toBe(
			true,
		);
	});

	test("a slow kafka describe times out per-describe; other groups still describe (SIO-1115)", async () => {
		// Small per-describe timeout so the slow stub trips it without a real 15s wait.
		process.env.KG_TOPOLOGY_KAFKA_DESCRIBE_TIMEOUT_MS = "20";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		connectedServers = ["kafka-mcp"];
		toolRegistry.kafka = [
			{
				name: "kafka_list_consumer_groups",
				invoke: async () =>
					JSON.stringify([
						{ id: "cg-slow", state: "STABLE" },
						{ id: "cg-fast", state: "STABLE" },
					]),
			},
			{
				name: "kafka_describe_consumer_group",
				invoke: async (args) => {
					const groupId = (args as { groupId: string }).groupId;
					if (groupId === "cg-slow") {
						await new Promise((r) => setTimeout(r, 100)); // exceeds the 20ms per-describe timeout
					}
					return JSON.stringify({ offsets: [{ topic: `topic-${groupId}` }] });
				},
			},
		];
		const summary = await runTopologySweep();
		// the fast group's edge is present; the source is incomplete (one describe timed out) -> skip
		expect(summary.sources.kafka).toMatchObject({ edges: 1, sweepSkipped: true });
		expect(store.calls.some((c) => c.cypher.includes("MERGE") && c.params?.from === "cg-fast")).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("[r:CONSUMES_FROM]") && c.cypher.includes("AS misses"))).toBe(
			false,
		);
	});
});
