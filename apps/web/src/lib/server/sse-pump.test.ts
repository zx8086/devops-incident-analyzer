// apps/web/src/lib/server/sse-pump.test.ts
// SIO-775: verify pumpEventStream emits datasource_result events with typed
// findings when extractFindings completes.
import { describe, expect, test } from "bun:test";
import { pumpEventStream } from "./sse-pump.ts";

type LangGraphEvent = {
	event?: string;
	name?: string;
	tags?: string[];
	metadata?: { langgraph_node?: string };
	data?: {
		chunk?: { content?: unknown };
		output?: Record<string, unknown>;
		input?: Record<string, unknown>;
	};
};

async function* fromArray(events: LangGraphEvent[]): AsyncIterable<LangGraphEvent> {
	for (const e of events) yield e;
}

describe("pumpEventStream datasource_result", () => {
	test("emits one datasource_result per dataSourceResults entry on extractFindings end", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "extractFindings",
					data: {
						output: {
							dataSourceResults: [
								{
									dataSourceId: "kafka",
									status: "success",
									duration: 1234,
									kafkaFindings: {
										consumerGroups: [{ id: "pim-sink", state: "STABLE", totalLag: 42 }],
										dlqTopics: [{ name: "orders.dlq", totalMessages: 17, recentDelta: 3 }],
									},
								},
								{
									dataSourceId: "gitlab",
									status: "error",
									error: "MCP error -32010",
								},
							],
						},
					},
				},
			]),
			send,
		);

		const resultEvents = captured.filter((e) => e.type === "datasource_result");
		expect(resultEvents).toHaveLength(2);

		// SIO-785 follow-up: progress events emitted alongside results so the
		// store's dataSourceProgress map is populated and the Data Sources
		// section renders. Without this, findings cards have no row to mount.
		const progressEvents = captured.filter((e) => e.type === "datasource_progress");
		expect(progressEvents).toHaveLength(2);
		const kafkaProgress = progressEvents.find((e) => e.dataSourceId === "kafka");
		expect(kafkaProgress?.status).toBe("success");
		const gitlabProgress = progressEvents.find((e) => e.dataSourceId === "gitlab");
		expect(gitlabProgress?.status).toBe("error");
		expect(gitlabProgress?.message).toBe("MCP error -32010");

		const kafka = resultEvents.find((e) => e.dataSourceId === "kafka") as Record<string, unknown> | undefined;
		expect(kafka).toBeDefined();
		expect(kafka?.status).toBe("success");
		expect(kafka?.duration).toBe(1234);
		expect(kafka?.kafkaFindings).toEqual({
			consumerGroups: [{ id: "pim-sink", state: "STABLE", totalLag: 42 }],
			dlqTopics: [{ name: "orders.dlq", totalMessages: 17, recentDelta: 3 }],
		});

		const gitlab = resultEvents.find((e) => e.dataSourceId === "gitlab") as Record<string, unknown> | undefined;
		expect(gitlab?.status).toBe("error");
		expect(gitlab?.error).toBe("MCP error -32010");
		expect(gitlab?.kafkaFindings).toBeUndefined();
	});

	test("skips malformed entries silently", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "extractFindings",
					data: {
						output: {
							dataSourceResults: [
								null,
								{ dataSourceId: 42, status: "success" },
								{ dataSourceId: "kafka", status: "running" },
								{ dataSourceId: "kafka", status: "success" },
							],
						},
					},
				},
			]),
			send,
		);

		const resultEvents = captured.filter((e) => e.type === "datasource_result");
		expect(resultEvents).toHaveLength(1);
		expect(resultEvents[0]?.dataSourceId).toBe("kafka");
	});

	test("does nothing when output has no dataSourceResults", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const send = (event: Record<string, unknown>) => {
			captured.push(event);
		};

		await pumpEventStream(
			fromArray([
				{
					event: "on_chain_end",
					name: "extractFindings",
					data: { output: {} },
				},
			]),
			send,
		);

		const resultEvents = captured.filter((e) => e.type === "datasource_result");
		expect(resultEvents).toHaveLength(0);
	});
});
