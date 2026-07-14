// packages/agent/src/resolve-identifiers.test.ts

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
// Preserve the REAL module (esp. the ALS wrappers withAwsEstate/withElasticDeployment)
// and override ONLY getToolsForDataSource. Spreading the real exports avoids the
// bun mock.module cross-file leak (reference_bun_mock_namespace_live_binding_poisoning)
// that otherwise breaks sibling tests importing the genuine ALS wrappers.
import * as realBridge from "./mcp-bridge.ts";

// Registry of stubbed tools per datasource, controlled per-test. Each entry maps a
// tool name to an async invoke() returning a canned MCP payload (string or object).
type StubTool = { name: string; invoke: (args: unknown) => Promise<unknown> };
let toolRegistry: Record<string, StubTool[]> = {};

mock.module("./mcp-bridge.ts", () => ({
	...realBridge,
	getToolsForDataSource: (dataSourceId: string) => toolRegistry[dataSourceId] ?? [],
}));

import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import type { ResolvedIdentifiers } from "@devops-agent/shared";
import {
	_setResolveIdentifiersLoggerForTesting,
	applyGraphSeeds,
	bindingsReadDatasources,
	computeTargetSources,
	DEFAULT_PROBE_TIMEOUT_MS,
	fetchGraphSeeds,
	isBindingsReadEnabled,
	isResolveIdentifiersEnabled,
	pickServiceCandidates,
	probeTimeoutMs,
	resolveIdentifiers,
} from "./resolve-identifiers.ts";
import type { AgentStateType } from "./state.ts";

const ORIG_FLAG = process.env.RESOLVE_IDENTIFIERS_ENABLED;

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [new HumanMessage("order-service failing")],
		targetDataSources: [],
		targetDeployments: [],
		awsTargetEstates: [],
		extractedEntities: { dataSources: [] },
		investigationFocus: {
			services: ["order-service"],
			datasources: [],
			summary: "AFS lookup failing",
			establishedAtTurn: 1,
		},
		...overrides,
	} as AgentStateType;
}

function elasticAggPayload(keys: string[]): string {
	// mirrors the real two-block size:0 render
	return `Search results with aggregations (1 total hits, 2ms):\n\n${JSON.stringify({
		by_service: { buckets: keys.map((k) => ({ key: k, doc_count: 1 })) },
	})}`;
}

beforeEach(() => {
	process.env.RESOLVE_IDENTIFIERS_ENABLED = "true";
	toolRegistry = {};
	_setResolveIdentifiersLoggerForTesting({ info: () => {}, warn: () => {} });
});

afterEach(() => {
	if (ORIG_FLAG === undefined) delete process.env.RESOLVE_IDENTIFIERS_ENABLED;
	else process.env.RESOLVE_IDENTIFIERS_ENABLED = ORIG_FLAG;
	_setResolveIdentifiersLoggerForTesting(null);
});

// Restore the genuine mcp-bridge so the getToolsForDataSource override cannot leak
// into sibling test files run later in the same bun process.
afterAll(() => {
	mock.module("./mcp-bridge.ts", () => ({ ...realBridge }));
});

describe("gating and helpers", () => {
	test("isResolveIdentifiersEnabled is default ON: false only for 'false'/'0'", () => {
		expect(isResolveIdentifiersEnabled({})).toBe(true);
		expect(isResolveIdentifiersEnabled({ RESOLVE_IDENTIFIERS_ENABLED: "true" })).toBe(true);
		expect(isResolveIdentifiersEnabled({ RESOLVE_IDENTIFIERS_ENABLED: "1" })).toBe(true);
		expect(isResolveIdentifiersEnabled({ RESOLVE_IDENTIFIERS_ENABLED: "false" })).toBe(false);
		expect(isResolveIdentifiersEnabled({ RESOLVE_IDENTIFIERS_ENABLED: "0" })).toBe(false);
	});

	test("computeTargetSources prefers UI selection, else entity-extracted", () => {
		expect(computeTargetSources(makeState({ targetDataSources: ["elastic", "aws"] }))).toEqual(["elastic", "aws"]);
		expect(
			computeTargetSources(
				makeState({
					targetDataSources: [],
					extractedEntities: { dataSources: [{ id: "kafka", mentionedAs: "kafka" }] },
				}),
			),
		).toEqual(["kafka"]);
	});

	test("pickServiceCandidates keeps related, drops unrelated", () => {
		expect(pickServiceCandidates(["pvh-services-orders", "orders", "payments"], ["order-service"])).toEqual([
			"pvh-services-orders",
			"orders",
		]);
	});
});

describe("resolveIdentifiers node", () => {
	test("returns {} (pure no-op, does not touch state) when disabled", async () => {
		process.env.RESOLVE_IDENTIFIERS_ENABLED = "false";
		expect(await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }))).toEqual({});
	});

	test("CLEARS stale resolvedIdentifiers when there is no focus service", async () => {
		const state = makeState({ investigationFocus: undefined });
		expect(await resolveIdentifiers(state)).toEqual({ resolvedIdentifiers: undefined });
	});

	test("CLEARS stale resolvedIdentifiers when this turn produces no candidates", async () => {
		// enabled, focus present, elastic in scope, but the probe returns nothing.
		toolRegistry.elastic = [{ name: "elasticsearch_search", invoke: async () => elasticAggPayload([]) }];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }));
		expect(result).toEqual({ resolvedIdentifiers: undefined });
	});

	test("resolves elastic service.name from the discovery agg", async () => {
		toolRegistry.elastic = [
			{ name: "elasticsearch_search", invoke: async () => elasticAggPayload(["pvh-services-orders", "unrelated"]) },
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }));
		expect(result.resolvedIdentifiers?.elastic?.serviceNames).toEqual(["pvh-services-orders"]);
		expect(result.resolvedIdentifiers?.resolvedForServices).toEqual(["order-service"]);
	});

	// SIO-1086: the discovery agg must FILTER to the anchor token (wildcard) before
	// aggregating -- a plain global top-N terms agg drops low-volume services by
	// volume ranking, which reported prana-order-service absent even though it exists.
	test("elastic discovery query filters to the anchor token (not a global top-N agg)", async () => {
		const allArgs: Array<Record<string, unknown>> = [];
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async (args) => {
					allArgs.push(args as Record<string, unknown>);
					return elasticAggPayload(["prana-order-service"]);
				},
			},
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }));
		// low-volume prana-order-service is resolved because the query filtered to *order*
		expect(result.resolvedIdentifiers?.elastic?.serviceNames).toContain("prana-order-service");
		// the PROBE query (the wildcard agg, not the warm-up match_all) carries a wildcard
		// on the anchor token. Find it explicitly rather than assuming call order.
		const probeArgs = allArgs.find((a) => JSON.stringify(a.query ?? {}).includes("wildcard"));
		const q = JSON.stringify(probeArgs?.query ?? {});
		expect(q).toContain("wildcard");
		expect(q).toContain("service.name");
		expect(q).toContain("order");
	});

	// SIO-1086 A: the probe carries a mandatory x-elastic-deployment header, and the MCP
	// adapter forks a NEW (cold) session on the first invoke with that header -- which,
	// inside the timed probe, blows PROBE_TIMEOUT_MS. resolveIdentifiers must warm the
	// deployment-headed session OFF the probe budget FIRST (a cheap size:0/terminate_after:1
	// match_all), so the timed agg pays only query cost.
	test("elastic session is warmed (match_all + terminate_after) BEFORE the timed wildcard probe", async () => {
		const allArgs: Array<Record<string, unknown>> = [];
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async (args) => {
					allArgs.push(args as Record<string, unknown>);
					return elasticAggPayload(["prana-order-service"]);
				},
			},
		];
		await resolveIdentifiers(makeState({ targetDataSources: ["elastic"], targetDeployments: ["eu-b2b"] }));
		// first call is the warm-up: match_all + terminate_after, NO wildcard/aggs
		const warm = allArgs[0];
		expect(warm?.terminate_after).toBe(1);
		expect(JSON.stringify(warm?.query ?? {})).toContain("match_all");
		expect(JSON.stringify(warm?.query ?? {})).not.toContain("wildcard");
		// a later call is the real probe: wildcard-anchored agg
		expect(allArgs.some((a) => JSON.stringify(a.query ?? {}).includes("wildcard"))).toBe(true);
	});

	// A warm-up failure must NEVER fail the probe -- it is best-effort; the probe still runs.
	test("a warm-up throw is swallowed and the probe still resolves", async () => {
		let call = 0;
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async (args) => {
					call += 1;
					// first call is the warm-up (match_all) -> throw; probe call succeeds
					if (JSON.stringify((args as Record<string, unknown>).query ?? {}).includes("match_all")) {
						throw new Error("cold connect failed");
					}
					return elasticAggPayload(["prana-order-service"]);
				},
			},
		];
		const result = await resolveIdentifiers(
			makeState({ targetDataSources: ["elastic"], targetDeployments: ["eu-b2b"] }),
		);
		expect(result.resolvedIdentifiers?.elastic?.serviceNames).toContain("prana-order-service");
		expect(call).toBeGreaterThanOrEqual(2); // warm-up threw, probe still ran
	});

	test("resolves the FULL couchbase scope map (unfiltered)", async () => {
		const tree =
			"📁 Scope: new_model\n  └─ 📄 Collection: seasonal_assignment\n📁 Scope: _default\n  └─ (No collections)\n";
		toolRegistry.couchbase = [{ name: "capella_get_scopes_and_collections", invoke: async () => tree }];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["couchbase"] }));
		expect(result.resolvedIdentifiers?.couchbase?.scopes).toEqual({
			new_model: ["seasonal_assignment"],
			_default: [],
		});
	});

	test("resolves aws log groups matched to the focus, ignoring _error estates", async () => {
		toolRegistry.aws = [
			{
				name: "aws_logs_describe_log_groups",
				invoke: async () =>
					JSON.stringify({ logGroups: [{ logGroupName: "/ecs/order-service" }, { logGroupName: "/ecs/payments" }] }),
			},
		];
		const result = await resolveIdentifiers(
			makeState({ targetDataSources: ["aws"], awsTargetEstates: ["eu-oit-prd"] }),
		);
		expect(result.resolvedIdentifiers?.aws?.logGroups).toEqual(["/ecs/order-service"]);
	});

	test("aws probe is skipped (no throw) when there are no target estates", async () => {
		toolRegistry.aws = [
			{
				name: "aws_logs_describe_log_groups",
				invoke: async () => {
					throw new Error("must not be called outside withAwsEstate scope");
				},
			},
		];
		// aws in scope but awsTargetEstates empty -> probe returns nothing, no throw;
		// with a valid focus this turn, stale prior resolution is cleared.
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["aws"], awsTargetEstates: [] }));
		expect(result).toEqual({ resolvedIdentifiers: undefined });
	});

	test("a failing probe omits its datasource but others still resolve", async () => {
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async () => {
					throw new Error("elastic unreachable");
				},
			},
		];
		toolRegistry.couchbase = [
			{
				name: "capella_get_scopes_and_collections",
				invoke: async () => "📁 Scope: orders\n  └─ 📄 Collection: order_lines\n",
			},
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["elastic", "couchbase"] }));
		expect(result.resolvedIdentifiers?.elastic).toBeUndefined();
		expect(result.resolvedIdentifiers?.couchbase?.scopes).toEqual({ orders: ["order_lines"] });
	});

	test("kafka probe never passes a `filter` regex arg (avoids -32603)", async () => {
		const seenArgs: unknown[] = [];
		toolRegistry.kafka = [
			{
				name: "kafka_list_topics",
				invoke: async (args) => {
					seenArgs.push(args);
					return JSON.stringify({ topics: [{ name: "orders.v1" }], total: 1 });
				},
			},
			{
				name: "kafka_list_consumer_groups",
				invoke: async (args) => {
					seenArgs.push(args);
					return JSON.stringify([{ id: "orders-service-prd", state: "Stable" }]);
				},
			},
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["kafka"] }));
		expect(result.resolvedIdentifiers?.kafka?.topics).toEqual(["orders.v1"]);
		expect(result.resolvedIdentifiers?.kafka?.consumerGroups).toEqual(["orders-service-prd"]);
		for (const a of seenArgs) {
			expect((a as Record<string, unknown>).filter).toBeUndefined();
		}
	});

	test("gitlab probe lifts the numeric project_id", async () => {
		toolRegistry.gitlab = [
			{
				name: "gitlab_search",
				invoke: async () =>
					JSON.stringify([
						{ id: 41051769, name: "order-service", path_with_namespace: "pvhcorp/b2b/oit/order-service" },
					]),
			},
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["gitlab"] }));
		expect(result.resolvedIdentifiers?.gitlab).toEqual({
			projectId: "41051769",
			pathWithNamespace: "pvhcorp/b2b/oit/order-service",
		});
	});

	test("konnect probe resolves the control plane then its matching service", async () => {
		toolRegistry.konnect = [
			{
				name: "konnect_list_control_planes",
				invoke: async () => JSON.stringify({ controlPlanes: [{ controlPlaneId: "cp-1", name: "orders-cp" }] }),
			},
			{
				name: "konnect_list_services",
				invoke: async () =>
					JSON.stringify({
						services: [
							{ serviceId: "svc-1", name: "order-service" },
							{ serviceId: "svc-2", name: "payments" },
						],
					}),
			},
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["konnect"] }));
		expect(result.resolvedIdentifiers?.konnect?.controlPlaneId).toBe("cp-1");
		expect(result.resolvedIdentifiers?.konnect?.serviceIds).toEqual(["svc-1"]);
	});

	// SIO-1096: the atlassian probe was removed (Jira projects are team/org-named, not
	// service-named, so name-matching resolved nothing). atlassian in scope resolves nothing.
	test("atlassian is not probed -- it never contributes resolved identifiers", async () => {
		toolRegistry.atlassian = [
			{ name: "atlassian_getVisibleJiraProjects", invoke: async () => JSON.stringify([{ key: "ORDER" }]) },
		];
		toolRegistry.elastic = [
			{ name: "elasticsearch_search", invoke: async () => elasticAggPayload(["pvh-services-orders"]) },
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["atlassian", "elastic"] }));
		// `atlassian` is not a key on ResolvedIdentifiers anymore -- only elastic resolves.
		expect(result.resolvedIdentifiers && "atlassian" in result.resolvedIdentifiers).toBe(false);
		expect(result.resolvedIdentifiers?.elastic?.serviceNames).toEqual(["pvh-services-orders"]);
	});

	test("a konnect probe failure omits konnect but other datasources still resolve", async () => {
		toolRegistry.konnect = [
			{
				name: "konnect_list_control_planes",
				invoke: async () => {
					throw new Error("konnect unreachable");
				},
			},
		];
		toolRegistry.elastic = [{ name: "elasticsearch_search", invoke: async () => elasticAggPayload(["orders"]) }];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["konnect", "elastic"] }));
		expect(result.resolvedIdentifiers?.konnect).toBeUndefined();
		expect(result.resolvedIdentifiers?.elastic?.serviceNames).toEqual(["orders"]);
	});
});

// SIO-1095: the 4000ms default was too tight and timed out the atlassian/elastic probes under
// normal proxy latency, dropping their grounding. Default is now 8000ms and env-tunable.
describe("probeTimeoutMs (SIO-1095)", () => {
	test("defaults to 8000 when unset", () => {
		expect(probeTimeoutMs({})).toBe(8000);
		expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(8000);
	});

	test("reads RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS when a positive number", () => {
		expect(probeTimeoutMs({ RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS: "12000" })).toBe(12000);
	});

	test("falls back to the default on invalid/non-positive values", () => {
		expect(probeTimeoutMs({ RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS: "abc" })).toBe(8000);
		expect(probeTimeoutMs({ RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS: "0" })).toBe(8000);
		expect(probeTimeoutMs({ RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS: "-500" })).toBe(8000);
	});

	test("rejects non-integers and values that overflow setTimeout (CodeRabbit)", () => {
		// > 2^31-1 overflows setTimeout to 1ms -> near-instant false negatives; must fall back.
		expect(probeTimeoutMs({ RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS: "2147483648" })).toBe(8000);
		expect(probeTimeoutMs({ RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS: "99999999999" })).toBe(8000);
		// Decimals are not valid timer delays either.
		expect(probeTimeoutMs({ RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS: "8000.5" })).toBe(8000);
		// The max valid value is accepted as-is.
		expect(probeTimeoutMs({ RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS: "2147483647" })).toBe(2147483647);
	});
});

// SIO-1101 (R7): graph-seeded identifiers.
describe("R7 graph seeds (SIO-1101)", () => {
	const ORIG_READ = process.env.KG_BINDINGS_READ_ENABLED;
	const ORIG_DS = process.env.KG_BINDINGS_READ_DATASOURCES;
	const ORIG_KG = process.env.KNOWLEDGE_GRAPH_ENABLED;

	afterEach(() => {
		_setGraphStoreForTesting(null);
		for (const [k, v] of [
			["KG_BINDINGS_READ_ENABLED", ORIG_READ],
			["KG_BINDINGS_READ_DATASOURCES", ORIG_DS],
			["KNOWLEDGE_GRAPH_ENABLED", ORIG_KG],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	function binding(over: Partial<import("@devops-agent/knowledge-graph").ServiceBinding>) {
		return {
			service: "orders",
			datasource: "elastic",
			kind: "serviceName",
			resourceId: "orders-api",
			locator: "",
			confidence: 0.7,
			discoveredBy: "resolve-identifiers",
			lastVerified: "2026-07-14T00:00:00Z",
			...over,
		} as import("@devops-agent/knowledge-graph").ServiceBinding;
	}

	test("isBindingsReadEnabled is default ON: false only for 'false'/'0'", () => {
		expect(isBindingsReadEnabled({} as NodeJS.ProcessEnv)).toBe(true);
		expect(isBindingsReadEnabled({ KG_BINDINGS_READ_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
		expect(isBindingsReadEnabled({ KG_BINDINGS_READ_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
	});

	test("bindingsReadDatasources defaults to elastic,aws and parses a custom list", () => {
		expect([...bindingsReadDatasources({} as NodeJS.ProcessEnv)].sort()).toEqual(["aws", "elastic"]);
		expect(
			[...bindingsReadDatasources({ KG_BINDINGS_READ_DATASOURCES: "kafka, gitlab " } as NodeJS.ProcessEnv)].sort(),
		).toEqual(["gitlab", "kafka"]);
	});

	test("applyGraphSeeds adds graph-only identifiers, keeps probe-confirmed ones, caps per datasource", () => {
		const merged: ResolvedIdentifiers = {
			resolvedForTurn: 1,
			resolvedForServices: ["orders"],
			// probe already found orders-api -> it must NOT be counted as graph-seeded
			elastic: { serviceNames: ["orders-api"] },
		};
		const seeds = [
			binding({ kind: "serviceName", resourceId: "orders-api" }), // dup of probe
			binding({ kind: "serviceName", resourceId: "orders-worker" }), // new
			binding({ datasource: "aws", kind: "logGroup", resourceId: "/ecs/orders" }),
			...Array.from({ length: 7 }, (_, i) =>
				binding({ datasource: "aws", kind: "logGroup", resourceId: `/ecs/extra-${i}` }),
			),
		];
		const graphSeeded = applyGraphSeeds(merged, seeds);
		// probe-confirmed orders-api stays in the block but is NOT graph-seeded
		expect(merged.elastic?.serviceNames).toContain("orders-api");
		expect(graphSeeded).toContain("orders-worker");
		expect(graphSeeded).not.toContain("orders-api");
		// aws capped at 5 graph-only additions
		expect((merged.aws?.logGroups ?? []).length).toBeLessThanOrEqual(5);
		expect(graphSeeded.filter((v) => v.startsWith("/ecs/")).length).toBe(5);
	});

	test("fetchGraphSeeds returns [] when KG disabled or read flag off", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		process.env.KG_BINDINGS_READ_ENABLED = "true";
		expect(await fetchGraphSeeds(["orders"], new Set(["elastic"]))).toEqual([]);

		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		process.env.KG_BINDINGS_READ_ENABLED = "false";
		expect(await fetchGraphSeeds(["orders"], new Set(["elastic"]))).toEqual([]);
	});

	test("fetchGraphSeeds reads the store and filters to allowed datasources", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		process.env.KG_BINDINGS_READ_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("OBSERVED_IN", [
			{
				service: "orders",
				datasource: "elastic",
				kind: "serviceName",
				resourceId: "orders-api",
				locator: "",
				confidence: 0.7,
				discoveredBy: "x",
				lastVerified: "2026-07-14T00:00:00Z",
			},
			{
				service: "orders",
				datasource: "kafka",
				kind: "topic",
				resourceId: "orders.events",
				locator: "",
				confidence: 0.7,
				discoveredBy: "x",
				lastVerified: "2026-07-14T00:00:00Z",
			},
		]);
		_setGraphStoreForTesting(store);
		const seeds = await fetchGraphSeeds(["orders"], new Set(["elastic"]));
		// kafka binding filtered out (not in the allowed set)
		expect(seeds.map((s) => s.datasource)).toEqual(["elastic"]);
	});

	test("fetchGraphSeeds skips the store entirely for an empty allowlist (CodeRabbit)", async () => {
		process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
		process.env.KG_BINDINGS_READ_ENABLED = "true";
		const store = new InMemoryGraphStore();
		store.stub("OBSERVED_IN", [
			{
				service: "orders",
				datasource: "elastic",
				kind: "serviceName",
				resourceId: "orders-api",
				locator: "",
				confidence: 0.7,
				discoveredBy: "x",
				lastVerified: "2026-07-14T00:00:00Z",
			},
		]);
		_setGraphStoreForTesting(store);
		const seeds = await fetchGraphSeeds(["orders"], new Set());
		expect(seeds).toEqual([]);
		// no wasted store I/O when nothing this turn can accept a seed
		expect(store.calls).toEqual([]);
	});
});
