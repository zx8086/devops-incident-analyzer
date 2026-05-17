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
});
