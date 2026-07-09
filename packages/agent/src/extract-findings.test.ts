// agent/src/extract-findings.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { extractFindings } from "./extract-findings.ts";
import type { AgentStateType } from "./state.ts";
import { truncateToolOutput } from "./sub-agent-truncate-tool-output.ts";

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
						rawJson: { groups: [{ id: "notification-service", state: "EMPTY" }] },
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups).toEqual([{ id: "notification-service", state: "EMPTY" }]);
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
							rawJson: { groups: [{ id: "payments-service", state: "STABLE" }] },
						},
					],
				},
			],
		};
		const out = await extractFindings(state);
		expect(out.dataSourceResults?.[0]?.kafkaFindings?.consumerGroups?.[0]?.id).toBe("payments-service");
	});

	// SIO-785: confirms focusServices is collected from state.investigationFocus and
	// state.normalizedIncident.affectedServices, and passed into the kafka extractor.
	test("collects focusServices from investigationFocus + normalizedIncident and filters kafka findings", async () => {
		const state: AgentStateType = {
			...baseState(),
			investigationFocus: {
				services: ["notification-service"],
				datasources: ["kafka"],
				summary: "investigating notification lag",
				establishedAtTurn: 1,
			},
			normalizedIncident: {
				affectedServices: [{ name: "orders-service" }],
			},
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: "notification-service-consumer", state: "STABLE" },
							{ id: "orders-service-sink", state: "STABLE" },
							{ id: "unrelated-group", state: "STABLE" },
						],
					},
				]),
			],
		} as unknown as AgentStateType;
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups?.map((g) => g.id)).toEqual([
			"notification-service-consumer",
			"orders-service-sink",
		]);
	});

	test("with no investigationFocus or normalizedIncident, kafka extractor renders all groups", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: "notification-service", state: "STABLE" },
							{ id: "unrelated-group", state: "STABLE" },
						],
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups).toHaveLength(2);
	});
});

// SIO-1043: the persisted-state cap (sub-agent.ts) runs truncateToolOutput on the
// rawJson STRING form before extractFindings ever sees it. Proves the two stages
// compose: a 200-consumer-group payload gets capped at creation, and lag findings
// still extract from what survives (fewer items, but safeParse-clean per row).
describe("extractFindings survives the SIO-1043 persisted-state cap", () => {
	const STATE_CAP = 65_536;

	test("kafka_list_consumer_groups: capped 200-group payload still yields consumerGroups", async () => {
		// Real kafka_list_consumer_groups rows carry more than {id, state} (members,
		// partition assignments, etc.); the extractor's zod schema strips unknown keys,
		// so padding with an oversized field forces the payload past STATE_CAP without
		// affecting what the extractor actually reads.
		const groups = Array.from({ length: 200 }, (_, i) => ({
			id: `consumer-group-${i}`,
			state: i % 7 === 0 ? "EMPTY" : "STABLE",
			members: Array.from({ length: 8 }, (_, m) => ({ memberId: `member-${i}-${m}`, host: "10.0.0.1" })),
		}));
		const rawText = JSON.stringify(groups);
		const originalBytes = Buffer.byteLength(rawText, "utf8");
		expect(originalBytes).toBeGreaterThan(STATE_CAP); // sanity: payload must overflow the cap

		// Mirrors the sub-agent.ts SIO-1043 cap-at-creation step: cap the string, re-parse.
		const capped = truncateToolOutput(rawText, STATE_CAP);
		expect(capped.strategy).not.toBe("none");
		expect(capped.finalBytes).toBeLessThanOrEqual(STATE_CAP);
		const rawJson = JSON.parse(capped.content) as unknown;

		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [kafkaResult([{ toolName: "kafka_list_consumer_groups", rawJson }])],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");

		// Fewer than 200 (some dropped by the cap), but well-formed rows still parse
		// -- the trailing {_truncated, ...} marker fails safeParse and is silently skipped.
		expect(kafka?.kafkaFindings?.consumerGroups?.length).toBeGreaterThan(0);
		expect(kafka?.kafkaFindings?.consumerGroups?.length).toBeLessThan(200);
		expect(kafka?.kafkaFindings?.consumerGroups?.[0]?.id).toBe("consumer-group-0");
	});

	test("kafka_get_consumer_group_lag: single large payload survives the cap unchanged", async () => {
		// A single tool output well under the cap is left untouched (strategy "none"),
		// confirming the cap only engages on oversized payloads.
		const rawText = JSON.stringify({ groupId: "notification-service", totalLag: "4821" });
		const capped = truncateToolOutput(rawText, STATE_CAP);
		expect(capped.strategy).toBe("none");
		const rawJson = JSON.parse(capped.content) as unknown;

		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [kafkaResult([{ toolName: "kafka_get_consumer_group_lag", rawJson }])],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups?.[0]).toMatchObject({
			id: "notification-service",
			totalLag: 4821,
		});
	});
});

// SIO-1030: focusServices now reaches every extractor (not just kafka). One
// representative focus/off-focus pair per datasource proves the wiring in
// extract-findings.ts, and an unfocused variant proves the show-all guardrail.
describe("extractFindings focus scoping across datasources (SIO-1030)", () => {
	function stateFor(
		dataSourceId: string,
		toolOutputs: DataSourceResult["toolOutputs"],
		focus?: string[],
	): AgentStateType {
		return {
			...baseState(),
			...(focus ? { investigationFocus: { services: focus, datasources: [], summary: "", establishedAtTurn: 1 } } : {}),
			dataSourceResults: [{ dataSourceId, data: "prose", status: "success", duration: 10, toolOutputs }],
		} as unknown as AgentStateType;
	}

	test("aws: focus reaches extractAwsFindings (off-focus alarm dropped)", async () => {
		const outputs: DataSourceResult["toolOutputs"] = [
			{
				toolName: "aws_cloudwatch_describe_alarms",
				rawJson: {
					MetricAlarms: [
						{ AlarmName: "prices-api-v2-service-CPU", StateValue: "ALARM" },
						{ AlarmName: "bitly-service-Memory", StateValue: "ALARM" },
					],
				},
			},
		];
		const scoped = await extractFindings(stateFor("aws", outputs, ["prices-api-v2-service"]));
		expect(scoped.dataSourceResults?.[0]?.awsFindings?.alarms?.map((a) => a.name)).toEqual([
			"prices-api-v2-service-CPU",
		]);
		const showAll = await extractFindings(stateFor("aws", outputs));
		expect(showAll.dataSourceResults?.[0]?.awsFindings?.alarms).toHaveLength(2);
	});

	test("couchbase: focus reaches extractCouchbaseFindings (off-focus query dropped)", async () => {
		const outputs: DataSourceResult["toolOutputs"] = [
			{
				toolName: "capella_get_longest_running_queries",
				rawJson: [
					{ statement: "SELECT * FROM `prices-api-v2-service` b" },
					{ statement: "SELECT * FROM `product_catalog` c" },
				],
			},
		];
		const scoped = await extractFindings(stateFor("couchbase", outputs, ["prices-api-v2-service"]));
		expect(scoped.dataSourceResults?.[0]?.couchbaseFindings?.slowQueries).toHaveLength(1);
		const showAll = await extractFindings(stateFor("couchbase", outputs));
		expect(showAll.dataSourceResults?.[0]?.couchbaseFindings?.slowQueries).toHaveLength(2);
	});

	test("gitlab: focus reaches extractGitLabFindings (off-focus MR dropped)", async () => {
		const outputs: DataSourceResult["toolOutputs"] = [
			{
				toolName: "gitlab_list_merge_requests",
				rawJson: [
					{ id: 1, title: "prices-api-v2-service paging fix" },
					{ id: 2, title: "kong-proxy timeout bump" },
				],
			},
		];
		const scoped = await extractFindings(stateFor("gitlab", outputs, ["prices-api-v2-service"]));
		expect(scoped.dataSourceResults?.[0]?.gitlabFindings?.mergedRequests?.map((m) => m.id)).toEqual([1]);
	});

	test("atlassian: focus reaches extractAtlassianFindings (off-focus issue dropped)", async () => {
		const outputs: DataSourceResult["toolOutputs"] = [
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					issues: [
						{ key: "INC-1", summary: "prices-api-v2-service 500s", status: "Open" },
						{ key: "INC-2", summary: "authentication-service latency", status: "Open" },
					],
				},
			},
		];
		const scoped = await extractFindings(stateFor("atlassian", outputs, ["prices-api-v2-service"]));
		expect(scoped.dataSourceResults?.[0]?.atlassianFindings?.linkedIssues?.map((i) => i.key)).toEqual(["INC-1"]);
	});
});
