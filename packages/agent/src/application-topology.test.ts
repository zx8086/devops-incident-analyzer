// agent/src/application-topology.test.ts
// SIO-1457: fixtures mirror real MCP response shapes -- the elastic MCP wraps
// aggregation responses as prefixed text ("Search results with aggregations
// (...):\n\n{...}"), kafka tools return the service shapes verified in
// mcp-server-kafka/src/services/kafka-service.ts and tools/output-schemas.ts.
import { describe, expect, test } from "bun:test";
import type { ApplicationTopologyEdge, DataSourceResult } from "@devops-agent/shared";
import {
	buildApplicationTopology,
	MAX_NODES,
	mergeApplicationTopologyOverlay,
	summarizeApplicationTopologyForPrompt,
} from "./application-topology.ts";

function elasticResult(toolOutputs: { toolName: string; rawJson: unknown }[]): DataSourceResult {
	return { dataSourceId: "elastic", data: {}, status: "success", toolOutputs };
}
function kafkaResult(toolOutputs: { toolName: string; rawJson: unknown }[]): DataSourceResult {
	return { dataSourceId: "kafka", data: {}, status: "success", toolOutputs };
}

const DESTINATION_AGG_JSON = {
	by_source: {
		buckets: [
			{
				key: "checkout-service",
				doc_count: 5000,
				by_destination: {
					buckets: [
						{
							key: "payment-service",
							doc_count: 3000,
							avg_duration: { value: 240000 },
							error_count: { doc_count: 63 },
						},
						{ key: "postgresql", doc_count: 1500, avg_duration: { value: 5000 }, error_count: { doc_count: 0 } },
						{ key: "kafka/orders", doc_count: 500, avg_duration: { value: 1000 }, error_count: { doc_count: 0 } },
					],
				},
			},
			{
				key: "payment-service",
				doc_count: 2000,
				by_destination: {
					buckets: [{ key: "redis", doc_count: 2000, avg_duration: { value: 800 }, error_count: { doc_count: 4 } }],
				},
			},
		],
	},
};

// Real MCP payload: prefix sentence + JSON, joined by normalizeToolContent.
const DESTINATION_AGG_OUT = {
	toolName: "elasticsearch_search",
	rawJson: `Search results with aggregations (7000 total hits, 312ms):\n\n${JSON.stringify(DESTINATION_AGG_JSON)}`,
};

const HEALTH_AGG_OUT = {
	toolName: "elasticsearch_search",
	rawJson: {
		aggregations: {
			by_service: {
				buckets: [
					{
						key: "checkout-service",
						doc_count: 10000,
						errors: { doc_count: 500 },
						avg_duration: { value: 120000 },
					},
				],
			},
		},
	},
};

const DESCRIBE_CG_OUT = {
	toolName: "kafka_describe_consumer_group",
	rawJson: {
		groupId: "order-workers",
		state: "Stable",
		protocol: "range",
		members: [{ id: "m-1", clientId: "order-worker-1", clientHost: "/10.0.1.5" }],
		offsets: [
			{ topic: "orders", partitions: [{ partition: 0, committedOffset: "1000" }] },
			{ topic: "orders-dlq", partitions: [{ partition: 0, committedOffset: "17" }] },
		],
	},
};

describe("buildApplicationTopology - elastic APM", () => {
	test("returns undefined when no outputs produced nodes", () => {
		expect(buildApplicationTopology([], [])).toBeUndefined();
		expect(buildApplicationTopology([elasticResult([])], [])).toBeUndefined();
	});

	test("destination aggregation yields calls edges, classifying services vs dependencies", () => {
		const t = buildApplicationTopology([elasticResult([DESTINATION_AGG_OUT])], []);
		expect(t).toBeDefined();
		if (!t) return;
		// payment-service is itself a source bucket -> service node, not dependency.
		expect(t.nodes.find((n) => n.id === "svc:payment-service")?.kind).toBe("service");
		expect(t.nodes.find((n) => n.id === "dep:postgresql")?.kind).toBe("dependency");
		expect(t.nodes.find((n) => n.id === "dep:redis")?.kind).toBe("dependency");
		const call = t.edges.find((e) => e.from === "svc:checkout-service" && e.to === "svc:payment-service");
		expect(call?.kind).toBe("calls");
		expect(call?.detail).toBe("avg 240ms, 2.1% err");
		expect(t.edges).toContainEqual({
			from: "svc:checkout-service",
			to: "dep:postgresql",
			kind: "calls",
			detail: "avg 5ms, 0.0% err",
		});
		expect(t.sources).toEqual(["elastic"]);
	});

	test("kafka-bus destinations are skipped (kafka edges come from the kafka datasource)", () => {
		const t = buildApplicationTopology([elasticResult([DESTINATION_AGG_OUT])], []);
		expect(t?.nodes.find((n) => n.id === "dep:kafka/orders")).toBeUndefined();
		expect(t?.edges.find((e) => e.to === "dep:kafka/orders")).toBeUndefined();
	});

	test("by_service health aggregation tints service nodes without creating edges", () => {
		const t = buildApplicationTopology([elasticResult([DESTINATION_AGG_OUT, HEALTH_AGG_OUT])], []);
		const svc = t?.nodes.find((n) => n.id === "svc:checkout-service");
		expect(svc?.errorRate).toBe(0.05);
		expect(svc?.avgDurationMs).toBe(120);
		expect(svc?.transactionCount).toBe(10000);
		// Health agg alone adds no edges beyond the destination agg's three.
		expect(t?.edges.length).toBe(3);
	});

	test("focus-matched services carry the service anchor field", () => {
		const t = buildApplicationTopology([elasticResult([DESTINATION_AGG_OUT])], ["checkout-service"]);
		expect(t?.nodes.find((n) => n.id === "svc:checkout-service")?.service).toBe("checkout-service");
		expect(t?.nodes.find((n) => n.id === "svc:payment-service")?.service).toBeUndefined();
	});

	test("malformed rawJson is skipped, never thrown", () => {
		const t = buildApplicationTopology(
			[
				elasticResult([
					{ toolName: "elasticsearch_search", rawJson: "no braces here" },
					{ toolName: "elasticsearch_search", rawJson: 42 },
					{ toolName: "elasticsearch_search", rawJson: { hits: { total: 0 } } },
					DESTINATION_AGG_OUT,
				]),
			],
			[],
		);
		expect(t?.nodes.find((n) => n.id === "svc:checkout-service")).toBeDefined();
	});
});

describe("buildApplicationTopology - kafka", () => {
	test("describe_consumer_group yields consumerGroup node and consumes edges", () => {
		const t = buildApplicationTopology([kafkaResult([DESCRIBE_CG_OUT])], []);
		expect(t).toBeDefined();
		if (!t) return;
		const cg = t.nodes.find((n) => n.id === "cg:order-workers");
		expect(cg?.kind).toBe("consumerGroup");
		expect(cg?.name).toBe("order-workers (Stable)");
		expect(t.nodes.find((n) => n.id === "topic:orders")?.kind).toBe("kafkaTopic");
		expect(t.edges).toContainEqual({ from: "cg:order-workers", to: "topic:orders", kind: "consumes" });
		expect(t.edges).toContainEqual({ from: "cg:order-workers", to: "topic:orders-dlq", kind: "consumes" });
		expect(t.sources).toEqual(["kafka"]);
	});

	test("consumer_group_lag contributes lag detail; zero lag renders no detail", () => {
		const t = buildApplicationTopology(
			[
				kafkaResult([
					{
						toolName: "kafka_get_consumer_group_lag",
						rawJson: {
							groupId: "order-workers",
							groupState: "Stable",
							topics: [
								{ topic: "orders", partitions: [], totalLag: "1200" },
								{ topic: "orders-dlq", partitions: [], totalLag: "0" },
							],
							totalLag: "1200",
						},
					},
				]),
			],
			[],
		);
		const lagging = t?.edges.find((e) => e.to === "topic:orders");
		expect(lagging?.detail).toBe("lag 1200");
		const clean = t?.edges.find((e) => e.to === "topic:orders-dlq");
		expect(clean?.detail).toBeUndefined();
	});

	test("list_consumer_groups enriches nodes in both bare-array and wrapped shapes, no edges", () => {
		const bare = buildApplicationTopology(
			[
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [{ id: "audit-workers", state: "Empty", groupType: "classic", protocolType: "consumer" }],
					},
				]),
			],
			[],
		);
		expect(bare?.nodes.find((n) => n.id === "cg:audit-workers")?.name).toBe("audit-workers (Empty)");
		expect(bare?.edges.length).toBe(0);

		const wrapped = buildApplicationTopology(
			[
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: { groups: [{ id: "audit-workers", state: "Empty" }] },
					},
				]),
			],
			[],
		);
		expect(wrapped?.nodes.find((n) => n.id === "cg:audit-workers")).toBeDefined();
	});

	test("merge-not-clobber: lag output does not erase describe state labelling", () => {
		const t = buildApplicationTopology(
			[
				kafkaResult([
					DESCRIBE_CG_OUT,
					{
						toolName: "kafka_get_consumer_group_lag",
						rawJson: { groupId: "order-workers", topics: [{ topic: "orders", partitions: [], totalLag: "50" }] },
					},
				]),
			],
			[],
		);
		expect(t?.nodes.find((n) => n.id === "cg:order-workers")?.name).toBe("order-workers (Stable)");
		// The lag sighting fills the detail gap on the existing consumes edge.
		expect(t?.edges.find((e) => e.to === "topic:orders")?.detail).toBe("lag 50");
	});
});

describe("buildApplicationTopology - caps", () => {
	test("caps nodes at MAX_NODES, drops dangling edges, flags truncated", () => {
		const buckets = Array.from({ length: MAX_NODES + 20 }, (_, i) => ({
			key: `svc-${i}`,
			doc_count: 10,
			by_destination: { buckets: [{ key: `svc-${i + 1}`, doc_count: 5 }] },
		}));
		const t = buildApplicationTopology(
			[
				elasticResult([
					{
						toolName: "elasticsearch_search",
						rawJson: { aggregations: { by_source: { buckets } } },
					},
				]),
			],
			[],
		);
		expect(t?.truncated).toBe(true);
		expect(t?.nodes.length).toBe(MAX_NODES);
		const kept = new Set(t?.nodes.map((n) => n.id));
		for (const e of t?.edges ?? []) {
			expect(kept.has(e.from)).toBe(true);
			expect(kept.has(e.to)).toBe(true);
		}
	});
});

describe("mergeApplicationTopologyOverlay", () => {
	const overlay: ApplicationTopologyEdge[] = [
		{ from: "svc:checkout-service", to: "svc:inventory-service", kind: "calls", detail: "orbit-name-match" },
		{ from: "cg:order-workers", to: "topic:orders", kind: "consumes" },
		{ from: "svc:checkout-service", to: "aws:arn:aws:ecs:eu-west-1:1:service/prod/checkout", kind: "runs-on" },
	];

	test("overlay-only turn still renders, with all edges marked priorKnowledge", () => {
		const t = mergeApplicationTopologyOverlay(undefined, overlay, 3);
		expect(t).toBeDefined();
		if (!t) return;
		expect(t.builtAtTurn).toBe(3);
		expect(t.sources).toEqual(["knowledge-graph"]);
		expect(t.edges.every((e) => e.priorKnowledge === true)).toBe(true);
		// Nodes minted from the id-prefix contract.
		expect(t.nodes.find((n) => n.id === "svc:inventory-service")?.kind).toBe("service");
		expect(t.nodes.find((n) => n.id === "cg:order-workers")?.kind).toBe("consumerGroup");
		expect(t.nodes.find((n) => n.id.startsWith("aws:"))?.kind).toBe("awsResource");
	});

	test("an observed edge wins over its overlay duplicate (priorKnowledge cleared)", () => {
		const built = buildApplicationTopology([kafkaResult([DESCRIBE_CG_OUT])], []);
		const t = mergeApplicationTopologyOverlay(built, overlay, 0);
		const dup = t?.edges.find((e) => e.from === "cg:order-workers" && e.to === "topic:orders");
		expect(dup?.priorKnowledge).toBeUndefined();
		// Non-duplicate overlay edges keep the flag.
		const kg = t?.edges.find((e) => e.to === "svc:inventory-service");
		expect(kg?.priorKnowledge).toBe(true);
		expect(t?.sources).toEqual(["kafka", "knowledge-graph"]);
	});

	test("empty overlay is a pass-through", () => {
		const built = buildApplicationTopology([kafkaResult([DESCRIBE_CG_OUT])], []);
		expect(mergeApplicationTopologyOverlay(built, [], 0)).toBe(built);
		expect(mergeApplicationTopologyOverlay(undefined, [], 0)).toBeUndefined();
	});
});

describe("summarizeApplicationTopologyForPrompt", () => {
	test("renders calls, consumer, and error-rate lines; skips prior knowledge", () => {
		const built = buildApplicationTopology(
			[elasticResult([DESTINATION_AGG_OUT, HEALTH_AGG_OUT]), kafkaResult([DESCRIBE_CG_OUT])],
			[],
		);
		expect(built).toBeDefined();
		if (!built) return;
		const merged = mergeApplicationTopologyOverlay(
			built,
			[{ from: "svc:checkout-service", to: "svc:inventory-service", kind: "calls" }],
			0,
		);
		expect(merged).toBeDefined();
		if (!merged) return;
		const summary = summarizeApplicationTopologyForPrompt(merged);
		expect(summary).toContain("- checkout-service -> payment-service (avg 240ms, 2.1% err)");
		expect(summary).toContain("- checkout-service -> postgresql [dependency]");
		expect(summary).toContain("consumes orders");
		expect(summary).toContain("- checkout-service: 5.0% error rate");
		expect(summary).not.toContain("inventory-service");
	});

	test("caps output at the prompt line budget", () => {
		const buckets = Array.from({ length: 40 }, (_, i) => ({
			key: `svc-${i}`,
			doc_count: 10,
			by_destination: { buckets: [{ key: `dep-${i}`, doc_count: 5 }] },
		}));
		const t = buildApplicationTopology(
			[elasticResult([{ toolName: "elasticsearch_search", rawJson: { by_source: { buckets } } }])],
			[],
		);
		expect(t).toBeDefined();
		if (!t) return;
		const lines = summarizeApplicationTopologyForPrompt(t).split("\n");
		expect(lines.length).toBeLessThanOrEqual(20);
		expect(lines[lines.length - 1]).toContain("more lines");
	});
});
