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

// SIO-902: synthetics drift events round-trip through the discriminated union.
describe("StreamEventSchema synthetics events", () => {
	const validReport = {
		type: "synthetics_drift_report",
		deployment: "eu-b2b",
		kibanaUrl: "https://x.es.io:443",
		kibanaSpace: "dev",
		hasActionableDrift: true,
		totals: {
			projectsChecked: 10,
			monitorsInSource: 81,
			monitorsInKibana: 254,
			missingInKibana: 0,
			extraInKibana: 132,
			changed: 41,
		},
		drift: [
			{
				project: "eu-oit.prd",
				monitorId: "a",
				monitorName: "OIT API",
				category: "changed",
				fields: [{ field: "name", source: "OIT", live: "Prana" }],
			},
		],
		reconcilePlan: {
			pushToKibana: { command: "c", monitors: [{ project: "eu-oit.prd", monitorId: "a", monitorName: "OIT API" }] },
			addToSource: { action: "x", monitors: [] },
		},
	};

	test("parses a well-formed synthetics_drift_report", () => {
		const parsed = StreamEventSchema.parse(validReport);
		expect(parsed.type).toBe("synthetics_drift_report");
		if (parsed.type !== "synthetics_drift_report") throw new Error("narrow");
		expect(parsed.totals.extraInKibana).toBe(132);
		expect(parsed.drift[0]?.category).toBe("changed");
	});

	test("rejects an unknown monitor category", () => {
		expect(() =>
			StreamEventSchema.parse({
				...validReport,
				drift: [{ project: "p", monitorId: "a", monitorName: "a", category: "deleted_somewhere" }],
			}),
		).toThrow();
	});

	test("rejects a report missing totals", () => {
		const { totals: _omit, ...noTotals } = validReport;
		expect(() => StreamEventSchema.parse(noTotals)).toThrow();
	});

	test("parses synthetics_push_choice and synthetics_push_result", () => {
		expect(
			StreamEventSchema.parse({
				type: "synthetics_push_choice",
				threadId: "t1",
				deployment: "eu-b2b",
				kibanaSpace: "dev",
				pushableCount: 2,
				extraCount: 1,
				projectScope: "eu-oit.prd",
				command: "c",
				pushMonitors: [{ project: "eu-oit.prd", monitorName: "a" }],
				extraMonitors: [{ project: "eu-ss.dev", monitorName: "b" }],
				message: "Approve?",
			}).type,
		).toBe("synthetics_push_choice");
		expect(
			StreamEventSchema.parse({
				type: "synthetics_push_result",
				status: "pushed",
				pushedCount: 2,
				project: "eu-oit.prd",
			}).type,
		).toBe("synthetics_push_result");
	});

	test("rejects a push result with a non-numeric pushedCount", () => {
		expect(() =>
			StreamEventSchema.parse({ type: "synthetics_push_result", status: "pushed", pushedCount: "2" }),
		).toThrow();
	});

	test("projectScope accepts null (fleet-wide)", () => {
		const parsed = StreamEventSchema.parse({
			type: "synthetics_push_choice",
			threadId: "t1",
			deployment: "eu-b2b",
			kibanaSpace: "dev",
			pushableCount: 2,
			extraCount: 0,
			projectScope: null,
			command: "c",
			pushMonitors: [],
			extraMonitors: [],
			message: "Approve?",
		});
		expect(parsed.type).toBe("synthetics_push_choice");
		if (parsed.type !== "synthetics_push_choice") throw new Error("narrow");
		expect(parsed.projectScope).toBeNull();
	});
});
