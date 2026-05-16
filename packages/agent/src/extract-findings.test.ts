// agent/src/extract-findings.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { extractFindings } from "./extract-findings.ts";
import type { AgentStateType } from "./state.ts";

function baseState(): AgentStateType {
	return { dataSourceResults: [] } as unknown as AgentStateType;
}

function kafkaResult(toolOutputs: DataSourceResult["toolOutputs"]): DataSourceResult {
	return {
		dataSourceId: "kafka",
		data: "prose summary",
		status: "success",
		duration: 100,
		toolOutputs,
	};
}

describe("extractFindings node", () => {
	test("populates kafkaFindings on the kafka DataSourceResult", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: { groups: [{ id: "notification-service", state: "Empty" }] },
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups).toEqual([{ id: "notification-service", state: "Empty" }]);
	});

	test("leaves non-kafka results untouched (no extractor registered)", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				{
					dataSourceId: "elastic",
					data: "prose",
					status: "success",
					duration: 50,
					toolOutputs: [{ toolName: "es_search", rawJson: { hits: [] } }],
				},
			],
		};
		const out = await extractFindings(state);
		const elastic = out.dataSourceResults?.find((r) => r.dataSourceId === "elastic");
		expect(elastic).toBeDefined();
		expect((elastic as unknown as { kafkaFindings?: unknown }).kafkaFindings).toBeUndefined();
	});

	test("soft-fails (returns the result unchanged) when the extractor throws", async () => {
		// Pass a non-iterable in place of toolOutputs[] so the extractor's `for...of` throws.
		// The node's try/catch must absorb it and leave kafkaFindings undefined.
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				{
					dataSourceId: "kafka",
					data: "prose summary",
					status: "success",
					duration: 100,
					toolOutputs: { not: "iterable" } as unknown as DataSourceResult["toolOutputs"],
				},
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings).toBeUndefined();
	});

	test("preserves prose result.data unchanged", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [kafkaResult([])],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.data).toBe("prose summary");
	});

	test("end-to-end: a kafka_list_consumer_groups toolOutput parsed from a JSON string flows through", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				{
					dataSourceId: "kafka",
					data: "summary",
					status: "success",
					duration: 100,
					toolOutputs: [
						{
							toolName: "kafka_list_consumer_groups",
							rawJson: { groups: [{ id: "payments-service", state: "Stable" }] },
						},
					],
				},
			],
		};
		const out = await extractFindings(state);
		expect(out.dataSourceResults?.[0]?.kafkaFindings?.consumerGroups?.[0]?.id).toBe("payments-service");
	});
});
