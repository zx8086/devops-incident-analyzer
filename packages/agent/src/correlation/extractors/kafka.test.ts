// packages/agent/src/correlation/extractors/kafka.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractKafkaFindings } from "./kafka.ts";

describe("extractKafkaFindings", () => {
	test("returns empty findings when no relevant tool outputs are present", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "kafka_list_topics", rawJson: { topics: [] } },
		];
		expect(extractKafkaFindings(outputs)).toEqual({});
	});

	test("maps kafka_list_consumer_groups response to consumerGroups[] with state", () => {
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

	test("maps each kafka_get_consumer_group_lag call to a consumerGroups[] entry with totalLag", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "notification-service", totalLag: 1234 },
			},
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "payments-service", totalLag: 0 },
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", totalLag: 1234 },
			{ id: "payments-service", totalLag: 0 },
		]);
	});

	test("merges state + totalLag by group id when both tools were called", () => {
		const outputs: ToolOutput[] = [
			{
				toolName: "kafka_list_consumer_groups",
				rawJson: { groups: [{ id: "notification-service", state: "Empty" }] },
			},
			{
				toolName: "kafka_get_consumer_group_lag",
				rawJson: { groupId: "notification-service", totalLag: 9999 },
			},
		];
		const findings = extractKafkaFindings(outputs);
		expect(findings.consumerGroups).toEqual([
			{ id: "notification-service", state: "Empty", totalLag: 9999 },
		]);
	});

	test("ignores tool outputs whose rawJson is a string (non-JSON tool result)", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "kafka_list_consumer_groups", rawJson: "upstream returned 503" },
		];
		expect(extractKafkaFindings(outputs)).toEqual({});
	});

	test("ignores malformed tool outputs (missing expected fields)", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "kafka_list_consumer_groups", rawJson: { unexpected: true } },
			{ toolName: "kafka_get_consumer_group_lag", rawJson: { totalLag: 5 } },
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
