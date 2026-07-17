// agent/src/extract-findings.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult, ToolOutput } from "@devops-agent/shared";
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

// SIO-1047 Task B1: characterization coverage for the 3 complex functions fallow
// flagged in this file (`fallow health --format json`, "targets" section, path
// packages/agent/src/extract-findings.ts): collectFocusServices (cognitive 8,
// crap 31.6), countRawConsumerGroups (cognitive 25, crap 97.0), and the `elastic`
// extractor closure inside extractFindings's `extractors` map (cognitive 10,
// crap 106.4 -- highest of the three despite the lowest cognitive score, because
// CRAP = CC^2 * (1 - cov/100)^3 + CC uses cyclomatic 20 there). These functions are
// NOT modified by this task -- zero production changes, characterization only:
// assert CURRENT behavior so a future refactor has a safety net.
//
// collectFocusServices and countRawConsumerGroups are file-private (not exported),
// so they are exercised indirectly through extractFindings, same as the rest of
// this file. The `elastic` closure is likewise only reachable via extractFindings
// with a dataSourceId: "elastic" result.

describe("extractFindings: collectFocusServices branch coverage (SIO-1047)", () => {
	// collectFocusServices unions state.investigationFocus?.services and
	// state.normalizedIncident?.affectedServices[].name into a deduped Set, then
	// Array.from()s it. Every extractor call reads it via the shared `focusServices`
	// closure variable, so we observe its output through the kafka extractor's
	// focus-scoping (already proven wired in the "focus scoping" tests above) --
	// here the assertions are about which entries end up in the union, not
	// about the kafka filter logic itself.

	// NOTE: fixture ids below deliberately use distinctive service names
	// (notification-service / payments-service / orders-service / catalog-service),
	// not generic "service-a"/"service-b". matchesFocus (correlation/focus-match.ts)
	// tokenizes on `-_.` and matches on token overlap for tokens >=4 chars; ids that
	// only differ by a single short suffix (e.g. "service-a" vs "service-b") both
	// reduce to the shared token "service" and cross-match, which would make these
	// focus/off-focus assertions flaky for the wrong reason (token collision, not
	// collectFocusServices' own union logic).

	test("no investigationFocus and no normalizedIncident: empty union, show-all", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: "notification-service", state: "STABLE" },
							{ id: "payments-service", state: "STABLE" },
						],
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		// Empty focus union -> kafka's isRelevantById show-all guardrail keeps both.
		expect(kafka?.kafkaFindings?.consumerGroups).toHaveLength(2);
	});

	test("investigationFocus.services present, normalizedIncident absent: services alone populate the union", async () => {
		const state: AgentStateType = {
			...baseState(),
			investigationFocus: {
				services: ["notification-service"],
				datasources: [],
				summary: "",
				establishedAtTurn: 1,
			},
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: "notification-service", state: "STABLE" },
							{ id: "payments-service", state: "STABLE" },
						],
					},
				]),
			],
		} as unknown as AgentStateType;
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups?.map((g) => g.id)).toEqual(["notification-service"]);
	});

	test("normalizedIncident.affectedServices present, investigationFocus absent: affectedServices alone populate the union", async () => {
		const state: AgentStateType = {
			...baseState(),
			normalizedIncident: { affectedServices: [{ name: "payments-service" }] },
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: "notification-service", state: "STABLE" },
							{ id: "payments-service", state: "STABLE" },
						],
					},
				]),
			],
		} as unknown as AgentStateType;
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups?.map((g) => g.id)).toEqual(["payments-service"]);
	});

	test("both sources present with an overlapping name: deduped by the Set, not double-counted", async () => {
		const state: AgentStateType = {
			...baseState(),
			investigationFocus: {
				services: ["notification-service"],
				datasources: [],
				summary: "",
				establishedAtTurn: 1,
			},
			normalizedIncident: {
				affectedServices: [{ name: "notification-service" }, { name: "orders-service" }],
			},
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: "notification-service", state: "STABLE" },
							{ id: "orders-service", state: "STABLE" },
							{ id: "catalog-service", state: "STABLE" },
						],
					},
				]),
			],
		} as unknown as AgentStateType;
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		// Union has 2 distinct entries (notification-service deduped), so exactly 2 groups match.
		expect(kafka?.kafkaFindings?.consumerGroups?.map((g) => g.id).sort()).toEqual([
			"notification-service",
			"orders-service",
		]);
	});

	test("falsy entries are filtered out of both sources (empty-string service, nameless affectedService)", async () => {
		// collectFocusServices does `if (s) set.add(s)` for services[] and
		// `if (s?.name) set.add(s.name)` for affectedServices[] -- an empty string
		// or an affectedService with no `name` field must not enter the union.
		const state: AgentStateType = {
			...baseState(),
			investigationFocus: {
				services: ["", "notification-service"],
				datasources: [],
				summary: "",
				establishedAtTurn: 1,
			},
			normalizedIncident: {
				affectedServices: [{ name: undefined }, { name: "payments-service" }],
			},
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: "notification-service", state: "STABLE" },
							{ id: "payments-service", state: "STABLE" },
							{ id: "catalog-service", state: "STABLE" },
						],
					},
				]),
			],
		} as unknown as AgentStateType;
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups?.map((g) => g.id).sort()).toEqual([
			"notification-service",
			"payments-service",
		]);
	});

	test("investigationFocus.services is an empty array (present but empty): behaves like show-all when normalizedIncident is also absent", async () => {
		const state: AgentStateType = {
			...baseState(),
			investigationFocus: { services: [], datasources: [], summary: "", establishedAtTurn: 1 },
			dataSourceResults: [
				kafkaResult([
					{ toolName: "kafka_list_consumer_groups", rawJson: [{ id: "notification-service", state: "STABLE" }] },
				]),
			],
		} as unknown as AgentStateType;
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups).toHaveLength(1);
	});
});

describe("extractFindings: countRawConsumerGroups branch coverage (SIO-1047)", () => {
	// countRawConsumerGroups is a pure diagnostic counter (feeds the KafkaFindingsCard
	// log payload only -- it does not affect kafkaFindings). We can't assert on its
	// return value directly since it's file-private and only reaches a logger.warn/
	// info call, so these tests characterize it by NOT THROWING across every branch
	// it visibly handles, using the kafka extractor's real output as the sole
	// externally-observable proxy that extractFindings completed successfully.
	// (Grep-verified: logCard's payload including rawCount/sampleRawIds only reaches
	// pino, which is not asserted on elsewhere in this repo's unit tests either --
	// see kafka focus-scoping tests above, which only assert kafkaFindings.)

	test("kafka_list_consumer_groups as a bare array: counts unique ids", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: "group-a", state: "STABLE" },
							{ id: "group-b", state: "STABLE" },
						],
					},
				]),
			],
		};
		// No throw, and the kafkaFindings side-effect still lands (both branches share
		// the same toolOutputs, proving countRawConsumerGroups' array-shape branch
		// (Array.isArray(o.rawJson)) does not disturb the real extractor's own parse).
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups).toHaveLength(2);
	});

	test("kafka_list_consumer_groups wrapped in {groups: [...]}: counts unique ids via the wrapper branch", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: { groups: [{ id: "group-a", state: "STABLE" }] },
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups).toHaveLength(1);
	});

	test("kafka_list_consumer_groups with neither array nor {groups} shape: falls through to empty rows, no throw", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: { unexpectedShape: true },
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		// The real extractor's own safeParse also rejects this shape -> no findings.
		expect(kafka?.kafkaFindings?.consumerGroups).toBeUndefined();
	});

	test("rows with non-string/missing id are not counted (typeof/`in` guards), no throw", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: 12345, state: "STABLE" }, // id is a number, not a string
							{ state: "STABLE" }, // no id field at all
							"not-an-object", // not an object
							{ id: "group-valid", state: "STABLE" },
						],
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		// Only the well-formed row survives the real extractor's own zod parse too.
		expect(kafka?.kafkaFindings?.consumerGroups?.map((g) => g.id)).toEqual(["group-valid"]);
	});

	test("kafka_get_consumer_group_lag: well-formed groupId counted, malformed groupId skipped, no throw", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{ toolName: "kafka_get_consumer_group_lag", rawJson: { groupId: "group-a", totalLag: "42" } },
					{ toolName: "kafka_get_consumer_group_lag", rawJson: { groupId: 999, totalLag: "1" } }, // groupId not a string
					{ toolName: "kafka_get_consumer_group_lag", rawJson: { totalLag: "1" } }, // no groupId field
					{ toolName: "kafka_get_consumer_group_lag", rawJson: "not-an-object" }, // not an object at all
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups?.[0]).toMatchObject({ id: "group-a", totalLag: 42 });
	});

	test("more than 3 unique ids across both tool types: sampleIds caps at 3 internally, still no throw and findings unaffected", async () => {
		// Documents the `.slice(0, 3)` cap on sampleIds. Not directly assertable
		// (file-private, log-only), but exercising >3 unique ids proves the branch
		// executes without throwing and doesn't affect the real findings count.
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{
						toolName: "kafka_list_consumer_groups",
						rawJson: [
							{ id: "group-1", state: "STABLE" },
							{ id: "group-2", state: "STABLE" },
							{ id: "group-3", state: "STABLE" },
							{ id: "group-4", state: "STABLE" },
							{ id: "group-5", state: "STABLE" },
						],
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups).toHaveLength(5);
	});

	test("empty toolOutputs array: count is 0, no throw", async () => {
		const state: AgentStateType = { ...baseState(), dataSourceResults: [kafkaResult([])] };
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings).toEqual({});
	});

	test("unrelated tool names are ignored by both branches, no throw", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				kafkaResult([
					{ toolName: "kafka_list_topics", rawJson: { topics: ["a", "b"] } },
					{ toolName: "kafka_list_consumer_groups", rawJson: [{ id: "group-a", state: "STABLE" }] },
				]),
			],
		};
		const out = await extractFindings(state);
		const kafka = out.dataSourceResults?.find((r) => r.dataSourceId === "kafka");
		expect(kafka?.kafkaFindings?.consumerGroups).toHaveLength(1);
	});
});

describe("extractFindings: the `elastic` extractors-map closure branch coverage (SIO-1047)", () => {
	// The `elastic` closure (extract-findings.ts extractors.elastic) calls
	// extractElasticFindings twice (focused + unfocused-as-"raw"), sums
	// apmServices/logClusters/syntheticMonitors lengths for both, and calls logCard.
	// These tests exercise every combination of the three arrays being
	// present/absent/focus-filtered, mirroring the real MCP tool-output shapes used
	// in correlation/extractors/elastic.test.ts (SIO-787/788 fixtures).

	function elasticResult(toolOutputs: DataSourceResult["toolOutputs"]): DataSourceResult {
		return { dataSourceId: "elastic", data: "prose summary", status: "success", duration: 100, toolOutputs };
	}

	test("all three arrays populated simultaneously (synthetic + apm + log-cluster in one call)", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				elasticResult([
					{
						toolName: "elasticsearch_search",
						toolArgs: { index: "synthetics-prod-*" },
						rawJson: {
							hits: {
								hits: [
									{
										_source: {
											monitor: { name: "phase-a-monitor", status: "up" },
											"@timestamp": "2026-05-18T07:00:00.000Z",
										},
									},
								],
							},
						},
					} as unknown as ToolOutput,
					{
						toolName: "elasticsearch_search",
						toolArgs: { index: "traces-apm-*" },
						rawJson: {
							aggregations: {
								by_service: {
									buckets: [
										{
											key: "phase-b-service",
											doc_count: 100,
											errors: { doc_count: 5 },
											avg_duration: { value: 250000 },
										},
									],
								},
							},
						},
					} as unknown as ToolOutput,
					{
						toolName: "elasticsearch_search",
						toolArgs: { index: "logs-app-*" },
						rawJson: {
							hits: {
								hits: [
									{
										_source: {
											message: "Phase-c distinctive repeating failure pattern xyzzy",
											level: "error",
										},
									},
								],
							},
						},
					} as unknown as ToolOutput,
				]),
			],
		};
		const out = await extractFindings(state);
		const elastic = out.dataSourceResults?.find((r) => r.dataSourceId === "elastic");
		expect(elastic?.elasticFindings?.syntheticMonitors).toHaveLength(1);
		expect(elastic?.elasticFindings?.apmServices).toHaveLength(1);
		expect(elastic?.elasticFindings?.logClusters).toHaveLength(1);
	});

	test("only syntheticMonitors populated (apmServices and logClusters both undefined)", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [
				elasticResult([
					{
						toolName: "elasticsearch_search",
						rawJson: {
							hits: {
								hits: [
									{
										_source: {
											monitor: { name: "solo-monitor", status: "down" },
											"@timestamp": "2026-05-18T07:00:00.000Z",
										},
									},
								],
							},
						},
					},
				]),
			],
		};
		const out = await extractFindings(state);
		const elastic = out.dataSourceResults?.find((r) => r.dataSourceId === "elastic");
		expect(elastic?.elasticFindings?.syntheticMonitors).toHaveLength(1);
		expect(elastic?.elasticFindings?.apmServices).toBeUndefined();
		expect(elastic?.elasticFindings?.logClusters).toBeUndefined();
	});

	test("no elasticsearch outputs at all: all three arrays undefined, rawCount and filteredCount both 0, no throw", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [elasticResult([{ toolName: "kafka_list_topics", rawJson: { topics: [] } }])],
		};
		const out = await extractFindings(state);
		const elastic = out.dataSourceResults?.find((r) => r.dataSourceId === "elastic");
		expect(elastic?.elasticFindings).toEqual({});
	});

	test("empty toolOutputs array: elasticFindings is {}", async () => {
		const state: AgentStateType = { ...baseState(), dataSourceResults: [elasticResult([])] };
		const out = await extractFindings(state);
		const elastic = out.dataSourceResults?.find((r) => r.dataSourceId === "elastic");
		expect(elastic?.elasticFindings).toEqual({});
	});

	test("focus scoping drops an off-focus APM service (raw vs filtered counts diverge inside the closure)", async () => {
		const state: AgentStateType = {
			...baseState(),
			investigationFocus: {
				services: ["prices-api-v2-service"],
				datasources: ["elastic"],
				summary: "investigating prices-api-v2-service errors",
				establishedAtTurn: 1,
			},
			dataSourceResults: [
				elasticResult([
					{
						toolName: "elasticsearch_search",
						toolArgs: { index: "traces-apm-*" },
						rawJson: {
							aggregations: {
								by_service: {
									buckets: [
										{ key: "prices-api-v2-service", doc_count: 10, errors: { doc_count: 1 } },
										{ key: "unrelated-service", doc_count: 10, errors: { doc_count: 1 } },
									],
								},
							},
						},
					} as unknown as ToolOutput,
				]),
			],
		} as unknown as AgentStateType;
		const out = await extractFindings(state);
		const elastic = out.dataSourceResults?.find((r) => r.dataSourceId === "elastic");
		// Focused call keeps only the matching service; the closure's "raw" re-run
		// (empty focus) is used only for the diagnostic log, not the returned findings.
		expect(elastic?.elasticFindings?.apmServices?.map((s) => s.serviceName)).toEqual(["prices-api-v2-service"]);
	});

	test("malformed rawJson (not parseable as any known elastic shape): soft-fails to elasticFindings {}, no throw", async () => {
		const state: AgentStateType = {
			...baseState(),
			dataSourceResults: [elasticResult([{ toolName: "elasticsearch_search", rawJson: "not json at all { broken" }])],
		};
		const out = await extractFindings(state);
		const elastic = out.dataSourceResults?.find((r) => r.dataSourceId === "elastic");
		expect(elastic?.elasticFindings).toEqual({});
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

	test("couchbase: resolved keyspace matching the focus bridges service -> collection (SIO-1138)", async () => {
		const outputs: DataSourceResult["toolOutputs"] = [
			{
				toolName: "capella_get_longest_running_queries",
				rawJson: [
					{ statement: "SELECT * FROM orders o WHERE o.status = 'OPEN'" },
					{ statement: "SELECT * FROM `product_catalog` c" },
				],
			},
		];
		const state = {
			...stateFor("couchbase", outputs, ["prana-order-service"]),
			resolvedIdentifiers: { couchbase: { scopes: { sales: ["orders"] } } },
		} as unknown as AgentStateType;
		const res = await extractFindings(state);
		const findings = res.dataSourceResults?.[0]?.couchbaseFindings;
		expect(findings?.slowQueries?.map((q) => q.statement)).toEqual(["SELECT * FROM orders o WHERE o.status = 'OPEN'"]);
		expect(findings?.unscoped).toBeUndefined();
	});

	test("couchbase: unscoped fallback flags rows when nothing matches the focus (SIO-1138)", async () => {
		const outputs: DataSourceResult["toolOutputs"] = [
			{
				toolName: "capella_get_longest_running_queries",
				rawJson: [
					{ statement: "SELECT * FROM `styles`.`variant` v" },
					{ statement: "SELECT * FROM system:completed_requests" },
				],
			},
		];
		const res = await extractFindings(stateFor("couchbase", outputs, ["prana-order-service"]));
		const findings = res.dataSourceResults?.[0]?.couchbaseFindings;
		expect(findings?.unscoped).toBe(true);
		expect(findings?.slowQueries?.map((q) => q.statement)).toEqual(["SELECT * FROM `styles`.`variant` v"]);
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
