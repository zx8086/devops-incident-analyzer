// packages/agent/src/correlation/extractors/kafka.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractKafkaFindings } from "./kafka.ts";

describe("extractKafkaFindings", () => {
	test("returns empty findings when no relevant tool outputs are present", () => {
		const outputs: ToolOutput[] = [{ toolName: "kafka_list_topics", rawJson: { topics: [] } }];
		expect(extractKafkaFindings(outputs)).toEqual({});
	});

	// SIO-783: real MCP shape — kafka-service.listConsumerGroups returns a bare
	// Array<{id, state, groupType, protocolType}> serialized via JSON.stringify.
	// Extra fields beyond {id, state} are ignored by the row schema.
	test("maps real-MCP bare-array kafka_list_consumer_groups response to consumerGroups[]", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_consumer_groups",
				rawJson: [
					{ id: "notification-service", state: "STABLE", groupType: "consumer", protocolType: "consumer" },
					{ id: "payments-service", state: "EMPTY", groupType: "consumer", protocolType: "consumer" },
				],
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", state: "STABLE" },
			{ id: "payments-service", state: "EMPTY" },
		]);
	});

	// SIO-783: back-compat — older callers / tests may wrap in {groups: [...]}.
	test("also accepts wrapped {groups: [...]} shape for back-compat", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_consumer_groups",
				rawJson: {
					groups: [
						{ id: "notification-service", state: "STABLE" },
						{ id: "payments-service", state: "EMPTY" },
					],
				},
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", state: "STABLE" },
			{ id: "payments-service", state: "EMPTY" },
		]);
	});

	// SIO-783: real MCP shape — kafka-service.getConsumerGroupLag returns totalLag
	// as a string. Schema coerces to number.
	test("coerces totalLag string to number (real MCP shape)", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "notification-service", totalLag: "1234", topics: [] },
			},
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "payments-service", totalLag: "0", topics: [] },
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", totalLag: 1234 },
			{ id: "payments-service", totalLag: 0 },
		]);
	});

	test("also accepts numeric totalLag for back-compat", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "notification-service", totalLag: 1234 },
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([{ id: "notification-service", totalLag: 1234 }]);
	});

	test("merges state + totalLag by group id when both tools were called (real shapes)", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_consumer_groups",
				rawJson: [{ id: "notification-service", state: "EMPTY", groupType: "consumer", protocolType: "consumer" }],
			},
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "notification-service", totalLag: "9999", topics: [] },
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([{ id: "notification-service", state: "EMPTY", totalLag: 9999 }]);
	});

	test("ignores tool outputs whose rawJson is a string (non-JSON tool result)", () => {
		const outputs: ToolOutput[] = [{ toolName: "kafka_list_consumer_groups", rawJson: "upstream returned 503" }];
		expect(extractKafkaFindings(outputs)).toEqual({});
	});

	test("ignores malformed tool outputs (missing expected fields)", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "kafka_list_consumer_groups", rawJson: { unexpected: true } },
			{ toolName: "kafka_get_consumer_group_lag", rawJson: { totalLag: 5 } },
		];
		expect(extractKafkaFindings(outputs)).toEqual({});
	});

	// SIO-783: a string totalLag that isn't numeric (e.g. an error message leaked
	// into the field) should fail safeParse and skip the entry, not poison the map.
	test("skips lag entries whose totalLag is non-numeric string", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "broken-group", totalLag: "n/a", topics: [] },
			},
		];
		expect(extractKafkaFindings(outputs)).toEqual({});
	});

	// SIO-770: kafka_list_dlq_topics returns a bare DlqTopic[] (not wrapped in {topics:[...]}),
	// matching KafkaService.listDlqTopics + ResponseBuilder.success(JSON.stringify).
	test("maps kafka_list_dlq_topics bare array response to dlqTopics[]", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_dlq_topics",
				rawJson: [
					{ name: "orders-dlq", totalMessages: 1247, recentDelta: 12 },
					{ name: "shipments.DLQ", totalMessages: 88, recentDelta: 0 },
				],
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.dlqTopics).toEqual([
			{ name: "orders-dlq", totalMessages: 1247, recentDelta: 12 },
			{ name: "shipments.DLQ", totalMessages: 88, recentDelta: 0 },
		]);
	});

	test("preserves recentDelta:null when the second sample was unavailable", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_dlq_topics",
				rawJson: [{ name: "orders-dlq", totalMessages: 1247, recentDelta: null }],
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.dlqTopics?.[0]?.recentDelta).toBeNull();
	});

	// SIO-785 follow-up (2026-05-18): cluster summary tile from kafka_describe_cluster.
	// Shape live-probed against c72-shared-services-msk on 2026-05-18.
	test("maps kafka_describe_cluster to cluster summary", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_describe_cluster",
				rawJson: {
					brokers: [{ id: 1, host: "b-1.example.com", port: 9092, rack: "az1", isController: false }],
					controllerId: 2,
					brokerCount: 3,
					topicCount: 42,
					provider: "msk",
				},
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.cluster).toEqual({
			brokerCount: 3,
			topicCount: 42,
			controllerId: 2,
			provider: "msk",
		});
	});

	// SIO-785 follow-up (2026-05-18): Connect connectors section.
	// Shape: { connectors: { <name>: { status: { connector: {state}, tasks: [{state}], type } } } }
	test("maps connect_list_connectors (object-keyed shape) to connectors[]", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "connect_list_connectors",
				rawJson: {
					connectors: {
						C_SINK_COUCHBASE_ARTICLES_V3: {
							status: {
								name: "C_SINK_COUCHBASE_ARTICLES_V3",
								connector: { state: "RUNNING" },
								tasks: [
									{ id: 0, state: "RUNNING" },
									{ id: 1, state: "RUNNING" },
								],
								type: "sink",
							},
						},
						C_SOURCE_PIM_ARTICLES_V3: {
							status: {
								connector: { state: "FAILED" },
								tasks: [{ id: 0, state: "FAILED" }],
								type: "source",
							},
						},
					},
				},
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.connectors).toHaveLength(2);
		const byName = Object.fromEntries((findings.connectors ?? []).map((c) => [c.name, c]));
		expect(byName.C_SINK_COUCHBASE_ARTICLES_V3).toEqual({
			name: "C_SINK_COUCHBASE_ARTICLES_V3",
			state: "RUNNING",
			type: "sink",
			taskFailures: 0,
		});
		expect(byName.C_SOURCE_PIM_ARTICLES_V3).toEqual({
			name: "C_SOURCE_PIM_ARTICLES_V3",
			state: "FAILED",
			type: "source",
			taskFailures: 1,
		});
	});

	test("ignores connect_list_connectors when shape is bare array (back-compat-broken signal)", () => {
		// Real shape is object-keyed. A bare array means the upstream contract drifted —
		// the schema parse must fail cleanly, not emit garbage.
		const outputs: ToolOutput[] = [
			{
				toolName: "connect_list_connectors",
				rawJson: [{ name: "ignored" }],
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.connectors).toBeUndefined();
	});

	// SIO-785 follow-up (2026-05-18): ksqlDB queries section.
	// Shape: { queries: [{id, state, queryType, statusCount: {<replicaState>: count}}] }
	test("maps ksql_list_queries to ksqlQueries[]", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "ksql_list_queries",
				rawJson: {
					queries: [
						{
							id: "CSAS_S_PRIVATE_SINK_PIM_VARIANTS_V3_4859",
							state: "RUNNING",
							queryType: "PERSISTENT",
							statusCount: { RUNNING: 1, UNRESPONSIVE: 2 },
						},
						{
							id: "CSAS_S_PRIVATE_OTHER_4860",
							state: "ERROR",
							queryType: "PERSISTENT",
						},
					],
				},
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.ksqlQueries).toHaveLength(2);
		expect(findings.ksqlQueries?.[0]?.statusCount).toEqual({ RUNNING: 1, UNRESPONSIVE: 2 });
		expect(findings.ksqlQueries?.[1]?.statusCount).toBeUndefined();
	});

	// SIO-785: relevance filter — focusServices scopes findings to related groups.
	describe("relevance filter (SIO-785)", () => {
		const baseGroups = (groups: Array<{ id: string; state: string }>) => ({
			toolName: "kafka_list_consumer_groups",
			rawJson: groups,
		});
		const baseLag = (groupId: string, lag: string) => ({
			toolName: "kafka_get_consumer_group_lag",
			rawJson: { groupId, totalLag: lag, topics: [] },
		});

		test("empty focusServices returns all groups (fallback to current behavior)", () => {
			const outputs: ToolOutput[] = [
				baseGroups([
					{ id: "notification-service", state: "STABLE" },
					{ id: "orders-svc", state: "STABLE" },
					{ id: "payments-consumer", state: "STABLE" },
				]),
			];
			const findings = extractKafkaFindings(outputs, []);
			expect(findings.consumerGroups).toHaveLength(3);
		});

		test("exact normalized match passes", () => {
			const outputs: ToolOutput[] = [
				baseGroups([
					{ id: "notification-service", state: "STABLE" },
					{ id: "orders-svc", state: "STABLE" },
				]),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.consumerGroups?.map((g) => g.id)).toEqual(["notification-service"]);
		});

		test("plural-vs-singular match passes (kafka -service vs APM -services divergence)", () => {
			// reference_b2b_apm_service_naming: kafka uses `notification-service`,
			// Elastic APM uses `notifications-service`. Both normalize to "notification".
			const outputs: ToolOutput[] = [baseGroups([{ id: "notification-service-consumer", state: "STABLE" }])];
			const findings = extractKafkaFindings(outputs, ["notifications-service"]);
			expect(findings.consumerGroups).toHaveLength(1);
		});

		test("suffix-stripped match (-consumer, -sink, -prod, -eventing) passes", () => {
			const outputs: ToolOutput[] = [
				baseGroups([
					{ id: "orders-service-consumer", state: "STABLE" },
					{ id: "orders-service-prod", state: "STABLE" },
					{ id: "orders-service-sink", state: "STABLE" },
					{ id: "orders-service-eventing", state: "STABLE" },
					{ id: "unrelated-service", state: "STABLE" },
				]),
			];
			const findings = extractKafkaFindings(outputs, ["orders-service"]);
			expect(findings.consumerGroups?.map((g) => g.id)).toEqual([
				"orders-service-consumer",
				"orders-service-prod",
				"orders-service-sink",
				"orders-service-eventing",
			]);
		});

		test("token-overlap match passes (shared token of length >= 4)", () => {
			const outputs: ToolOutput[] = [baseGroups([{ id: "pim-sink-articles", state: "STABLE" }])];
			const findings = extractKafkaFindings(outputs, ["pim-articles-importer"]);
			// Shares "articles" token (length 8). Should match.
			expect(findings.consumerGroups).toHaveLength(1);
		});

		test("short common tokens (prod, svc, dev) do NOT cause false matches", () => {
			const outputs: ToolOutput[] = [baseGroups([{ id: "unrelated-prod", state: "STABLE" }])];
			const findings = extractKafkaFindings(outputs, ["notification-prod"]);
			// "prod" has length 4 but is in SUFFIX_PATTERN — gets stripped before tokenization.
			expect(findings.consumerGroups).toBeUndefined();
		});

		test("non-Stable state always passes through regardless of name match", () => {
			const outputs: ToolOutput[] = [
				baseGroups([
					{ id: "unrelated-group", state: "PREPARING_REBALANCE" },
					{ id: "another-group", state: "DEAD" },
					{ id: "third-group", state: "EMPTY" },
				]),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.consumerGroups?.map((g) => g.id)).toEqual(["unrelated-group", "another-group", "third-group"]);
		});

		test("non-zero totalLag always passes through regardless of name match", () => {
			const outputs: ToolOutput[] = [
				baseGroups([{ id: "unrelated-group", state: "STABLE" }]),
				baseLag("unrelated-group", "1500"),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.consumerGroups).toHaveLength(1);
			expect(findings.consumerGroups?.[0]?.totalLag).toBe(1500);
		});

		test("zero-lag stable group with no match is filtered out", () => {
			const outputs: ToolOutput[] = [
				baseGroups([{ id: "unrelated-group", state: "STABLE" }]),
				baseLag("unrelated-group", "0"),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.consumerGroups).toBeUndefined();
		});

		test("DLQ with recentDelta > 0 always passes through regardless of name match", () => {
			const outputs: ToolOutput[] = [
				{
					toolName: "kafka_list_dlq_topics",
					rawJson: [{ name: "unrelated-dlq", totalMessages: 50, recentDelta: 10 }],
				},
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.dlqTopics).toHaveLength(1);
		});

		test("DLQ with recentDelta = 0 / null and no name match is filtered out", () => {
			const outputs: ToolOutput[] = [
				{
					toolName: "kafka_list_dlq_topics",
					rawJson: [
						{ name: "unrelated-dlq-a", totalMessages: 50, recentDelta: 0 },
						{ name: "unrelated-dlq-b", totalMessages: 50, recentDelta: null },
					],
				},
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.dlqTopics).toBeUndefined();
		});

		test("DLQ name fuzzy-matches focus service via token overlap", () => {
			const outputs: ToolOutput[] = [
				{
					toolName: "kafka_list_dlq_topics",
					rawJson: [
						{ name: "notification-service-dlq", totalMessages: 50, recentDelta: 0 },
						{ name: "unrelated-dlq", totalMessages: 50, recentDelta: 0 },
					],
				},
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.dlqTopics?.map((d) => d.name)).toEqual(["notification-service-dlq"]);
		});

		test("multiple focus services match independently (any-of)", () => {
			const outputs: ToolOutput[] = [
				baseGroups([
					{ id: "notification-service", state: "STABLE" },
					{ id: "orders-service", state: "STABLE" },
					{ id: "unrelated-group", state: "STABLE" },
				]),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service", "orders-service"]);
			expect(findings.consumerGroups?.map((g) => g.id)).toEqual(["notification-service", "orders-service"]);
		});

		test("merged state + lag honors degraded pass-through after merge", () => {
			// Group is Stable from list call, but lag call later sets totalLag > 0.
			// The merged entry should pass the filter on lag.
			const outputs: ToolOutput[] = [
				baseGroups([{ id: "unrelated-group", state: "STABLE" }]),
				baseLag("unrelated-group", "42"),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.consumerGroups).toHaveLength(1);
			expect(findings.consumerGroups?.[0]).toEqual({
				id: "unrelated-group",
				state: "STABLE",
				totalLag: 42,
			});
		});
	});
});

// SIO-1149: fallback DLQ derivation. When kafka_list_dlq_topics fails/times out and the
// sub-agent inspects a DLQ topic directly (kafka_describe_topic / kafka_get_topic_offsets),
// derive a dlqTopics row from the offset snapshot so the typed KafkaFindingsCard still
// carries the headline (the localcore run: 113k messages, dlqTopics:0). Offsets and
// timestamps are bigints serialized as STRINGS; partitions[].timestamp echoes the request
// sentinel ("-1" LATEST, "-2" EARLIEST).
describe("derived DLQ fallback (SIO-1149)", () => {
	const DLQ_NAME = "DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS";

	function describeTopicOut(name: string, partitions: Array<Record<string, unknown>>): ToolOutput {
		return {
			toolName: "kafka_describe_topic",
			rawJson: { name, offsets: { name, partitions }, configs: null },
		};
	}

	function topicOffsetsOut(name: string, partitions: Array<Record<string, unknown>>): ToolOutput {
		return { toolName: "kafka_get_topic_offsets", rawJson: { name, partitions } };
	}

	test("derives a DLQ row from kafka_describe_topic and bypasses focus scoping", () => {
		const outputs: ToolOutput[] = [
			describeTopicOut(DLQ_NAME, [
				{ partitionIndex: 0, timestamp: "-1", offset: "60000" },
				{ partitionIndex: 1, timestamp: "-1", offset: "53000" },
			]),
		];
		// Focus does NOT fuzzy-match the DLQ name -- the derived row must survive anyway.
		const findings = extractKafkaFindings(outputs, ["localcore-service"]);
		expect(findings.dlqTopics).toEqual([{ name: DLQ_NAME, totalMessages: 113000, recentDelta: null }]);
	});

	test("uses latest - earliest when both sentinel snapshots were sampled", () => {
		const outputs: ToolOutput[] = [
			topicOffsetsOut(DLQ_NAME, [{ partitionIndex: 0, timestamp: "-2", offset: "1000" }]),
			topicOffsetsOut(DLQ_NAME, [{ partitionIndex: 0, timestamp: "-1", offset: "114000" }]),
		];
		const findings = extractKafkaFindings(outputs, ["localcore-service"]);
		expect(findings.dlqTopics).toEqual([{ name: DLQ_NAME, totalMessages: 113000, recentDelta: null }]);
	});

	test("a missing timestamp field is treated as the LATEST default", () => {
		const outputs: ToolOutput[] = [topicOffsetsOut(DLQ_NAME, [{ partitionIndex: 0, offset: "500" }])];
		const findings = extractKafkaFindings(outputs, []);
		expect(findings.dlqTopics).toEqual([{ name: DLQ_NAME, totalMessages: 500, recentDelta: null }]);
	});

	test("a listed row for the same topic wins over the derived snapshot", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_dlq_topics",
				rawJson: [{ name: DLQ_NAME, totalMessages: 113092, recentDelta: 40 }],
			},
			describeTopicOut(DLQ_NAME, [{ partitionIndex: 0, timestamp: "-1", offset: "999999" }]),
		];
		const findings = extractKafkaFindings(outputs, []);
		expect(findings.dlqTopics).toEqual([{ name: DLQ_NAME, totalMessages: 113092, recentDelta: 40 }]);
	});

	test("non-DLQ topic names are never derived", () => {
		const outputs: ToolOutput[] = [
			describeTopicOut("T_PRIVATE_STOCK_RICH_NOTIFICATIONS", [{ partitionIndex: 0, timestamp: "-1", offset: "500" }]),
		];
		expect(extractKafkaFindings(outputs, [])).toEqual({});
	});

	test("dead-letter and dotted/suffixed DLQ forms are derived", () => {
		const outputs: ToolOutput[] = [
			describeTopicOut("orders-dlq", [{ partitionIndex: 0, timestamp: "-1", offset: "5" }]),
			describeTopicOut("payments.dead-letter.v1", [{ partitionIndex: 0, timestamp: "-1", offset: "7" }]),
		];
		const findings = extractKafkaFindings(outputs, []);
		expect(findings.dlqTopics).toHaveLength(2);
	});

	test("null offsets, non-object payloads, and zero totals are ignored", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "kafka_describe_topic", rawJson: { name: DLQ_NAME, offsets: null, configs: null } },
			{ toolName: "kafka_get_topic_offsets", rawJson: "broker error" },
			describeTopicOut("empty-dlq", [{ partitionIndex: 0, timestamp: "-1", offset: "0" }]),
		];
		expect(extractKafkaFindings(outputs, [])).toEqual({});
	});

	test("non-numeric offset strings fail the partition parse and are skipped", () => {
		const outputs: ToolOutput[] = [describeTopicOut(DLQ_NAME, [{ partitionIndex: 0, timestamp: "-1", offset: "n/a" }])];
		expect(extractKafkaFindings(outputs, [])).toEqual({});
	});
});
