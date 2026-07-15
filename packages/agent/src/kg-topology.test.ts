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
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(ORIG_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function apmPayload(pairs: Array<{ service: string; destinations: string[] }>): string {
	return `Search results with aggregations (100 total hits, 5ms):\n\n${JSON.stringify({
		by_service: {
			buckets: pairs.map((p) => ({
				key: p.service,
				by_dest: { buckets: p.destinations.map((d) => ({ key: d, doc_count: 1 })) },
			})),
		},
	})}`;
}

beforeEach(() => {
	process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
	process.env.KG_TOPOLOGY_CRON_ENABLED = "true";
	delete process.env.AWS_ESTATES;
	delete process.env.ELASTIC_DEPLOYMENTS;
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
					apmPayload([
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
					apmPayload([
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
});
