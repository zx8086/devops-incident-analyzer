// agent/src/application-topology.test.ts
// SIO-1457: fixtures mirror real MCP response shapes -- the elastic MCP wraps
// aggregation responses as prefixed text ("Search results with aggregations
// (...):\n\n{...}"), kafka tools return the service shapes verified in
// mcp-server-kafka/src/services/kafka-service.ts and tools/output-schemas.ts.
import { describe, expect, test } from "bun:test";
import type { ApplicationTopologyEdge, DataSourceResult } from "@devops-agent/shared";
import {
	buildApplicationTopology,
	hasDestinationAggregation,
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

	// SIO-1460: kafka + vert.x skip entirely; AMQP collapses to ONE broker node so
	// RabbitMQ presence stays visible without the per-queue storm.
	test("bus destinations: kafka+vert.x skipped, AMQP collapses to one broker node", () => {
		const json = {
			by_source: {
				buckets: [
					{
						key: "contact-service",
						doc_count: 100,
						by_destination: {
							buckets: [
								{ key: "kafka/orders", doc_count: 20 },
								{ key: "kafka://broker:9092", doc_count: 12 },
								{ key: "VERT.X/contact", doc_count: 30 },
								{ key: "AMQP 1.0/ddm.contact.sync", doc_count: 25 },
								{ key: "AMQP 1.0/ddm.voucher.sync", doc_count: 15 },
								{ key: "postgresql", doc_count: 10 },
							],
						},
					},
				],
			},
		};
		const t = buildApplicationTopology([elasticResult([{ toolName: "elasticsearch_search", rawJson: json }])], []);
		// kafka (path + URI forms) + vert.x (any case): no node, no edge.
		expect(t?.nodes.find((n) => n.id === "dep:kafka/orders")).toBeUndefined();
		expect(t?.nodes.find((n) => n.id === "dep:kafka://broker:9092")).toBeUndefined();
		expect(t?.nodes.find((n) => n.name === "VERT.X/contact")).toBeUndefined();
		// A URI-form kafka host must not slip through as a host-family dependency either.
		expect(t?.nodes.some((n) => n.kind === "dependency" && /kafka/i.test(n.name ?? ""))).toBe(false);
		// AMQP: one broker node, one edge (both queues collapse to it).
		const bus = t?.nodes.filter((n) => n.id === "dep:amqp-bus") ?? [];
		expect(bus.length).toBe(1);
		expect(bus[0]?.name).toBe("AMQP broker");
		expect(bus[0]?.kind).toBe("dependency");
		expect(t?.edges.filter((e) => e.to === "dep:amqp-bus").length).toBe(1);
		// Non-bus dependency still renders.
		expect(t?.nodes.find((n) => n.id === "dep:postgresql")?.kind).toBe("dependency");
	});

	// SIO-1460: subdomains of one registrable domain collapse to one dep node named
	// "<regdomain> (N hosts)". The family is keyed on the brand label (SLD label).
	test("subdomains of one domain collapse to one '(N hosts)' node", () => {
		const json = {
			by_source: {
				buckets: [
					{
						key: "storefront",
						doc_count: 100,
						by_destination: {
							buckets: [
								{ key: "www.calvinklein.de:443", doc_count: 10 },
								{ key: "img.calvinklein.de:443", doc_count: 8 },
								{ key: "postgresql", doc_count: 5 },
							],
						},
					},
				],
			},
		};
		const t = buildApplicationTopology([elasticResult([{ toolName: "elasticsearch_search", rawJson: json }])], []);
		// Both .de hosts collapse to one brand-keyed family node with a host count.
		const fam = t?.nodes.find((n) => n.id === "dep:calvinklein");
		expect(fam?.kind).toBe("dependency");
		expect(fam?.name).toBe("calvinklein.de (2 hosts)");
		expect(t?.edges.filter((e) => e.to === "dep:calvinklein").length).toBe(1);
		// Non-host resource passes through unchanged.
		expect(t?.nodes.find((n) => n.id === "dep:postgresql")).toBeDefined();
	});

	// SIO-1460 (live probe PR #650): the per-locale storefronts (www.calvinklein.de,
	// .es, .fr, .co.uk, ...) differ only by ccTLD -- they collapse to ONE brand node
	// named "<brand> (N locales)", the exact noise the ticket screenshot flagged.
	test("per-locale storefronts collapse to one brand node with a locale count", () => {
		const tlds = ["de", "es", "fr", "co.uk", "nl", "pl"];
		const json = {
			by_source: {
				buckets: [
					{
						key: "storefront",
						doc_count: 100,
						by_destination: {
							buckets: tlds.map((tld) => ({ key: `www.calvinklein.${tld}:443`, doc_count: 10 })),
						},
					},
				],
			},
		};
		const t = buildApplicationTopology([elasticResult([{ toolName: "elasticsearch_search", rawJson: json }])], []);
		const fam = t?.nodes.find((n) => n.id === "dep:calvinklein");
		expect(fam?.kind).toBe("dependency");
		expect(fam?.name).toBe("calvinklein (6 locales)");
		// One node, one edge for the whole storefront fleet.
		expect(t?.nodes.filter((n) => n.kind === "dependency").length).toBe(1);
		expect(t?.edges.filter((e) => e.to === "dep:calvinklein").length).toBe(1);
	});

	// Different brand labels do NOT merge even under the same TLD.
	test("distinct brand labels stay separate", () => {
		const json = {
			by_source: {
				buckets: [
					{
						key: "svc",
						doc_count: 10,
						by_destination: {
							buckets: [
								{ key: "baas.calvinkleinservice.com:443", doc_count: 5 },
								{ key: "baas.tommyhilfigercrm.com:443", doc_count: 4 },
							],
						},
					},
				],
			},
		};
		const t = buildApplicationTopology([elasticResult([{ toolName: "elasticsearch_search", rawJson: json }])], []);
		expect(t?.nodes.find((n) => n.id === "dep:calvinkleinservice")).toBeDefined();
		expect(t?.nodes.find((n) => n.id === "dep:tommyhilfigercrm")).toBeDefined();
	});

	test("single-host family renders the raw host, not '(1 hosts)'", () => {
		const json = {
			by_source: {
				buckets: [
					{
						key: "svc",
						doc_count: 10,
						by_destination: { buckets: [{ key: "api.internal.example.com:8080", doc_count: 5 }] },
					},
				],
			},
		};
		const t = buildApplicationTopology([elasticResult([{ toolName: "elasticsearch_search", rawJson: json }])], []);
		const n = t?.nodes.find((x) => x.id === "dep:example");
		expect(n?.name).toBe("api.internal.example.com:8080");
	});

	// SIO-1460 (CodeRabbit PR #650): the same host reached on different ports (or with
	// different casing) is ONE host -- membership is keyed on the normalized host, not
	// the raw host:port endpoint, so the count does not over-report.
	test("same host on differing ports counts as one host", () => {
		const json = {
			by_source: {
				buckets: [
					{
						key: "svc",
						doc_count: 10,
						by_destination: {
							buckets: [
								{ key: "api.shop.example.com:443", doc_count: 5 },
								{ key: "api.shop.example.com:8443", doc_count: 3 },
							],
						},
					},
				],
			},
		};
		const t = buildApplicationTopology([elasticResult([{ toolName: "elasticsearch_search", rawJson: json }])], []);
		// One distinct host -> single-host display (raw endpoint), not "(2 hosts)".
		const n = t?.nodes.find((x) => x.id === "dep:example");
		expect(n?.name).toBe("api.shop.example.com:443");
	});

	// SIO-1460 (live probe PR #650): APM emits placeholder exit-span destinations
	// keyed "0" (uninstrumented spans). Numeric/letterless resources are dropped.
	test("junk resource keys (no letters) produce no dependency node", () => {
		const json = {
			by_source: {
				buckets: [
					{
						key: "martech-voucher",
						doc_count: 10,
						by_destination: {
							buckets: [
								{ key: "0", doc_count: 5 },
								{ key: "-", doc_count: 2 },
								{ key: "redis", doc_count: 3 },
							],
						},
					},
				],
			},
		};
		const t = buildApplicationTopology([elasticResult([{ toolName: "elasticsearch_search", rawJson: json }])], []);
		expect(t?.nodes.find((n) => n.id === "dep:0")).toBeUndefined();
		expect(t?.nodes.find((n) => n.id === "dep:-")).toBeUndefined();
		// A real dependency in the same bucket still renders.
		expect(t?.nodes.find((n) => n.id === "dep:redis")).toBeDefined();
	});

	test("bare single-label host and IP literals are not collapsed", () => {
		const json = {
			by_source: {
				buckets: [
					{
						key: "svc",
						doc_count: 10,
						by_destination: {
							buckets: [
								{ key: "redis", doc_count: 5 },
								{ key: "10.0.0.5:6379", doc_count: 3 },
							],
						},
					},
				],
			},
		};
		const t = buildApplicationTopology([elasticResult([{ toolName: "elasticsearch_search", rawJson: json }])], []);
		expect(t?.nodes.find((n) => n.id === "dep:redis")).toBeDefined();
		expect(t?.nodes.find((n) => n.id === "dep:10.0.0.5:6379")).toBeDefined();
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

	// SIO-1460: focused turns keep anchors + their 1-hop neighborhood; unrelated
	// subgraphs are dropped. Empty focus is show-all (matchesFocus([]) anchors all).
	// Both endpoints of each subgraph are source buckets so they classify as svc:
	// nodes (an instrumented service calling another), not dep: nodes.
	const SCOPE_AGG = {
		by_source: {
			buckets: [
				{
					key: "checkout-service",
					doc_count: 10,
					by_destination: { buckets: [{ key: "payment-service", doc_count: 5 }] },
				},
				{ key: "payment-service", doc_count: 8, by_destination: { buckets: [] } },
				{
					key: "unrelated-service",
					doc_count: 10,
					by_destination: { buckets: [{ key: "other-service", doc_count: 5 }] },
				},
				{ key: "other-service", doc_count: 6, by_destination: { buckets: [] } },
			],
		},
	};
	const SCOPE_OUT = { toolName: "elasticsearch_search", rawJson: SCOPE_AGG };

	test("focused turn keeps anchors + 1-hop, drops unrelated nodes", () => {
		const t = buildApplicationTopology([elasticResult([SCOPE_OUT])], ["checkout"]);
		expect(t?.nodes.find((n) => n.id === "svc:checkout-service")).toBeDefined(); // anchor
		expect(t?.nodes.find((n) => n.id === "svc:payment-service")).toBeDefined(); // 1-hop
		expect(t?.nodes.find((n) => n.id === "svc:unrelated-service")).toBeUndefined();
		expect(t?.nodes.find((n) => n.id === "svc:other-service")).toBeUndefined();
	});

	test("unfocused turn scopes nothing (show-all)", () => {
		const t = buildApplicationTopology([elasticResult([SCOPE_OUT])], []);
		expect(t?.nodes.find((n) => n.id === "svc:unrelated-service")).toBeDefined();
		expect(t?.nodes.find((n) => n.id === "svc:other-service")).toBeDefined();
	});

	test("focus that matches nothing falls back to show-all (never blank)", () => {
		const t = buildApplicationTopology([elasticResult([SCOPE_OUT])], ["zzz-nomatch-service"]);
		expect((t?.nodes.length ?? 0) > 0).toBe(true);
		expect(t?.nodes.find((n) => n.id === "svc:unrelated-service")).toBeDefined();
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

	// SIO-1460: a focus-matching consumer group is an anchor (service field set), so
	// scopeToFocus retains it AND its 1-hop topics -- anchoring is not kind:"service".
	test("focus-matching consumer group anchor is retained with its topic 1-hop", () => {
		const t = buildApplicationTopology([kafkaResult([DESCRIBE_CG_OUT])], ["order-workers"]);
		expect(t?.nodes.find((n) => n.id === "cg:order-workers")?.service).toBe("order-workers");
		expect(t?.nodes.find((n) => n.id === "topic:orders")).toBeDefined();
		expect(t?.nodes.find((n) => n.id === "topic:orders-dlq")).toBeDefined();
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

	// SIO-1460: ranked truncation keeps a high-degree hub over degree-1 noise even
	// when the hub is inserted LAST (blind slice would drop it).
	test("ranked cap keeps a high-degree hub inserted last, over degree-1 noise", () => {
		// MAX_NODES degree-1 noise services (svc-i -> ndep-i), then a hub calling 10
		// of the noise services (so the hub has degree 10). Unfocused: no scoping.
		const noise = Array.from({ length: MAX_NODES }, (_, i) => ({
			key: `svc-${i}`,
			doc_count: 1,
			by_destination: { buckets: [{ key: `ndep-${i}`, doc_count: 1 }] },
		}));
		const hub = {
			key: "hub-service",
			doc_count: 999,
			by_destination: {
				buckets: Array.from({ length: 10 }, (_, i) => ({ key: `svc-${i}`, doc_count: 50 })),
			},
		};
		const t = buildApplicationTopology(
			[elasticResult([{ toolName: "elasticsearch_search", rawJson: { by_source: { buckets: [...noise, hub] } } }])],
			[],
		);
		expect(t?.truncated).toBe(true);
		expect(t?.nodes.length).toBe(MAX_NODES);
		expect(t?.nodes.find((n) => n.id === "svc:hub-service")).toBeDefined();
	});

	// SIO-1460: a focus anchor survives ranked truncation even when inserted last.
	// The anchor is the LAST source bucket but calls MAX_NODES+ distinct services, so
	// scopeToFocus retains all of them (1-hop neighborhood) and the surviving set still
	// exceeds MAX_NODES -- forcing capTopology to truncate. Ranking (service anchor
	// first) must keep the late-inserted checkout-service.
	test("ranked cap keeps the focus anchor even when inserted last", () => {
		// noise sources come first so the anchor lands last in Map insertion order.
		const noise = Array.from({ length: 20 }, (_, i) => ({
			key: `noise-${i}`,
			doc_count: 1,
			by_destination: { buckets: [{ key: `ndep-${i}`, doc_count: 1 }] },
		}));
		const anchored = {
			key: "checkout-service",
			doc_count: 999,
			by_destination: {
				buckets: Array.from({ length: MAX_NODES + 10 }, (_, i) => ({ key: `neighbor-${i}`, doc_count: 5 })),
			},
		};
		const t = buildApplicationTopology(
			[
				elasticResult([
					{ toolName: "elasticsearch_search", rawJson: { by_source: { buckets: [...noise, anchored] } } },
				]),
			],
			["checkout-service"],
		);
		// Scoping kept the anchor + its 1-hop neighbors (> MAX_NODES), so cap fired.
		expect(t?.truncated).toBe(true);
		expect(t?.nodes.length).toBe(MAX_NODES);
		// The focus anchor survives despite being inserted last.
		expect(t?.nodes.find((n) => n.id === "svc:checkout-service")).toBeDefined();
		// The unrelated noise subgraph was scoped out entirely.
		expect(t?.nodes.find((n) => n.id === "svc:noise-0")).toBeUndefined();
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

	// CodeRabbit PR #644: overlay edges arrive after observed ones; observed
	// latency/error detail must survive a duplicate overlay edge carrying its
	// own detail (the KG discoveredBy stamp).
	test("observed detail survives an overlay duplicate carrying its own detail", () => {
		const built = buildApplicationTopology([elasticResult([DESTINATION_AGG_OUT])], []);
		const t = mergeApplicationTopologyOverlay(
			built,
			[{ from: "svc:checkout-service", to: "svc:payment-service", kind: "calls", detail: "orbit-name-match" }],
			0,
		);
		const dup = t?.edges.find((e) => e.from === "svc:checkout-service" && e.to === "svc:payment-service");
		expect(dup?.detail).toBe("avg 240ms, 2.1% err");
		expect(dup?.priorKnowledge).toBeUndefined();
	});
});

describe("hasDestinationAggregation", () => {
	test("recognizes both string-wrapped and object-shaped payloads", () => {
		expect(hasDestinationAggregation(DESTINATION_AGG_OUT.rawJson)).toBe(true);
		expect(hasDestinationAggregation({ aggregations: DESTINATION_AGG_JSON })).toBe(true);
		expect(hasDestinationAggregation(DESTINATION_AGG_JSON)).toBe(true);
	});

	test("rejects unrelated text containing the substring and non-matching shapes", () => {
		expect(hasDestinationAggregation('log line mentioning by_destination routing {"hits": 3}')).toBe(false);
		expect(hasDestinationAggregation({ by_service: { buckets: [] } })).toBe(false);
		expect(hasDestinationAggregation(undefined)).toBe(false);
		expect(hasDestinationAggregation(42)).toBe(false);
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

	// SIO-1460: on a focused turn the summary reflects the scoped map. redis is 2
	// hops from the checkout anchor (only payment-service, an unanchored 1-hop
	// neighbor, calls it), so it is dropped; the checkout->payment calls line stays.
	test("prompt summary reflects the scoped map on a focused turn", () => {
		const built = buildApplicationTopology([elasticResult([DESTINATION_AGG_OUT])], ["checkout-service"]);
		expect(built).toBeDefined();
		if (!built) return;
		const summary = summarizeApplicationTopologyForPrompt(built);
		expect(summary).toContain("checkout-service -> payment-service");
		expect(summary).not.toContain("redis");
	});
});
