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

import {
	_setResolveIdentifiersLoggerForTesting,
	computeTargetSources,
	isResolveIdentifiersEnabled,
	pickServiceCandidates,
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
	test("isResolveIdentifiersEnabled reads the env flag", () => {
		expect(isResolveIdentifiersEnabled({ RESOLVE_IDENTIFIERS_ENABLED: "true" })).toBe(true);
		expect(isResolveIdentifiersEnabled({ RESOLVE_IDENTIFIERS_ENABLED: "1" })).toBe(true);
		expect(isResolveIdentifiersEnabled({})).toBe(false);
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
	test("returns {} when disabled", async () => {
		process.env.RESOLVE_IDENTIFIERS_ENABLED = "false";
		expect(await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }))).toEqual({});
	});

	test("returns {} when there is no focus service", async () => {
		const state = makeState({ investigationFocus: undefined });
		expect(await resolveIdentifiers(state)).toEqual({});
	});

	test("resolves elastic service.name from the discovery agg", async () => {
		toolRegistry.elastic = [
			{ name: "elasticsearch_search", invoke: async () => elasticAggPayload(["pvh-services-orders", "unrelated"]) },
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }));
		expect(result.resolvedIdentifiers?.elastic?.serviceNames).toEqual(["pvh-services-orders"]);
		expect(result.resolvedIdentifiers?.resolvedForServices).toEqual(["order-service"]);
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
		// aws in scope but awsTargetEstates empty -> probe returns nothing, no throw.
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["aws"], awsTargetEstates: [] }));
		expect(result).toEqual({});
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

	test("returns {} when every in-scope probe yields nothing", async () => {
		toolRegistry.elastic = [{ name: "elasticsearch_search", invoke: async () => elasticAggPayload([]) }];
		expect(await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }))).toEqual({});
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
});
