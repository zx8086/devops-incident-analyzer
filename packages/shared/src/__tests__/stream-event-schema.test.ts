// packages/shared/src/__tests__/stream-event-schema.test.ts
// SIO-775: round-trip tests for the new datasource_result event.
import { describe, expect, test } from "bun:test";
import { StreamEventSchema } from "../agent-state.ts";

describe("StreamEventSchema datasource_result", () => {
	test("parses a success result with kafkaFindings", () => {
		const parsed = StreamEventSchema.parse({
			type: "datasource_result",
			dataSourceId: "kafka-agent",
			status: "success",
			duration: 1234,
			kafkaFindings: {
				consumerGroups: [{ id: "pim-sink", state: "STABLE", totalLag: 42 }],
				dlqTopics: [{ name: "orders.dlq", totalMessages: 17, recentDelta: 3 }],
			},
		});
		expect(parsed.type).toBe("datasource_result");
		if (parsed.type !== "datasource_result") throw new Error("narrow");
		expect(parsed.kafkaFindings?.consumerGroups?.[0]?.id).toBe("pim-sink");
		expect(parsed.kafkaFindings?.dlqTopics?.[0]?.recentDelta).toBe(3);
	});

	test("parses an error result with no findings", () => {
		const parsed = StreamEventSchema.parse({
			type: "datasource_result",
			dataSourceId: "kafka-agent",
			status: "error",
			error: "MCP error -32010",
		});
		expect(parsed.type).toBe("datasource_result");
		if (parsed.type !== "datasource_result") throw new Error("narrow");
		expect(parsed.error).toBe("MCP error -32010");
		expect(parsed.kafkaFindings).toBeUndefined();
	});

	test("parses a result with dlqTopics.recentDelta=null (no baseline)", () => {
		const parsed = StreamEventSchema.parse({
			type: "datasource_result",
			dataSourceId: "kafka-agent",
			status: "success",
			kafkaFindings: {
				dlqTopics: [{ name: "orders.dlq", totalMessages: 5, recentDelta: null }],
			},
		});
		if (parsed.type !== "datasource_result") throw new Error("narrow");
		expect(parsed.kafkaFindings?.dlqTopics?.[0]?.recentDelta).toBeNull();
	});

	test("rejects invalid status", () => {
		expect(() =>
			StreamEventSchema.parse({
				type: "datasource_result",
				dataSourceId: "kafka-agent",
				status: "running",
			}),
		).toThrow();
	});
});
