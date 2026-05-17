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
					{ id: "notification-service", state: "Stable", groupType: "consumer", protocolType: "consumer" },
					{ id: "payments-service", state: "Empty", groupType: "consumer", protocolType: "consumer" },
				],
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", state: "Stable" },
			{ id: "payments-service", state: "Empty" },
		]);
	});

	// SIO-783: back-compat — older callers / tests may wrap in {groups: [...]}.
	test("also accepts wrapped {groups: [...]} shape for back-compat", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_consumer_groups",
				rawJson: {
					groups: [
						{ id: "notification-service", state: "Stable" },
						{ id: "payments-service", state: "Empty" },
					],
				},
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", state: "Stable" },
			{ id: "payments-service", state: "Empty" },
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
				rawJson: [{ id: "notification-service", state: "Empty", groupType: "consumer", protocolType: "consumer" }],
			},
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "notification-service", totalLag: "9999", topics: [] },
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([{ id: "notification-service", state: "Empty", totalLag: 9999 }]);
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
					{ id: "notification-service", state: "Stable" },
					{ id: "orders-svc", state: "Stable" },
					{ id: "payments-consumer", state: "Stable" },
				]),
			];
			const findings = extractKafkaFindings(outputs, []);
			expect(findings.consumerGroups).toHaveLength(3);
		});

		test("exact normalized match passes", () => {
			const outputs: ToolOutput[] = [
				baseGroups([
					{ id: "notification-service", state: "Stable" },
					{ id: "orders-svc", state: "Stable" },
				]),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.consumerGroups?.map((g) => g.id)).toEqual(["notification-service"]);
		});

		test("plural-vs-singular match passes (kafka -service vs APM -services divergence)", () => {
			// reference_b2b_apm_service_naming: kafka uses `notification-service`,
			// Elastic APM uses `notifications-service`. Both normalize to "notification".
			const outputs: ToolOutput[] = [baseGroups([{ id: "notification-service-consumer", state: "Stable" }])];
			const findings = extractKafkaFindings(outputs, ["notifications-service"]);
			expect(findings.consumerGroups).toHaveLength(1);
		});

		test("suffix-stripped match (-consumer, -sink, -prod, -eventing) passes", () => {
			const outputs: ToolOutput[] = [
				baseGroups([
					{ id: "orders-service-consumer", state: "Stable" },
					{ id: "orders-service-prod", state: "Stable" },
					{ id: "orders-service-sink", state: "Stable" },
					{ id: "orders-service-eventing", state: "Stable" },
					{ id: "unrelated-service", state: "Stable" },
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
			const outputs: ToolOutput[] = [baseGroups([{ id: "pim-sink-articles", state: "Stable" }])];
			const findings = extractKafkaFindings(outputs, ["pim-articles-importer"]);
			// Shares "articles" token (length 8). Should match.
			expect(findings.consumerGroups).toHaveLength(1);
		});

		test("short common tokens (prod, svc, dev) do NOT cause false matches", () => {
			const outputs: ToolOutput[] = [baseGroups([{ id: "unrelated-prod", state: "Stable" }])];
			const findings = extractKafkaFindings(outputs, ["notification-prod"]);
			// "prod" has length 4 but is in SUFFIX_PATTERN — gets stripped before tokenization.
			expect(findings.consumerGroups).toBeUndefined();
		});

		test("non-Stable state always passes through regardless of name match", () => {
			const outputs: ToolOutput[] = [
				baseGroups([
					{ id: "unrelated-group", state: "Rebalancing" },
					{ id: "another-group", state: "Dead" },
					{ id: "third-group", state: "Empty" },
				]),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.consumerGroups?.map((g) => g.id)).toEqual(["unrelated-group", "another-group", "third-group"]);
		});

		test("non-zero totalLag always passes through regardless of name match", () => {
			const outputs: ToolOutput[] = [
				baseGroups([{ id: "unrelated-group", state: "Stable" }]),
				baseLag("unrelated-group", "1500"),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.consumerGroups).toHaveLength(1);
			expect(findings.consumerGroups?.[0]?.totalLag).toBe(1500);
		});

		test("zero-lag stable group with no match is filtered out", () => {
			const outputs: ToolOutput[] = [
				baseGroups([{ id: "unrelated-group", state: "Stable" }]),
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
					{ id: "notification-service", state: "Stable" },
					{ id: "orders-service", state: "Stable" },
					{ id: "unrelated-group", state: "Stable" },
				]),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service", "orders-service"]);
			expect(findings.consumerGroups?.map((g) => g.id)).toEqual(["notification-service", "orders-service"]);
		});

		test("merged state + lag honors degraded pass-through after merge", () => {
			// Group is Stable from list call, but lag call later sets totalLag > 0.
			// The merged entry should pass the filter on lag.
			const outputs: ToolOutput[] = [
				baseGroups([{ id: "unrelated-group", state: "Stable" }]),
				baseLag("unrelated-group", "42"),
			];
			const findings = extractKafkaFindings(outputs, ["notification-service"]);
			expect(findings.consumerGroups).toHaveLength(1);
			expect(findings.consumerGroups?.[0]).toEqual({
				id: "unrelated-group",
				state: "Stable",
				totalLag: 42,
			});
		});
	});
});
