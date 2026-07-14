// agent/src/record-bindings.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "@devops-agent/knowledge-graph";
import type { DataSourceResult, ResolvedIdentifiers } from "@devops-agent/shared";
import {
	deriveConfirmedBindings,
	identifierUsedInToolCalls,
	isBindingsWriteEnabled,
	recordConfirmedBindings,
} from "./record-bindings.ts";
import type { AgentStateType } from "./state.ts";

// A single-service focus with a fresh (stamp-matching) resolution and one confirmed
// datasource. Overridable per test.
function baseState(over: Partial<AgentStateType> = {}): AgentStateType {
	const resolved: ResolvedIdentifiers = {
		resolvedForTurn: 1,
		resolvedForServices: ["orders"],
		aws: { logGroups: ["/ecs/orders-prd"] },
		elastic: { serviceNames: ["orders-api"] },
		...(over.resolvedIdentifiers as ResolvedIdentifiers | undefined),
	};
	return {
		requestId: "req-1",
		investigationFocus: {
			services: ["orders"],
			datasources: ["aws", "elastic"],
			summary: "orders incident",
			establishedAtTurn: 1,
		},
		resolvedIdentifiers: resolved,
		dataSourceResults: [
			{ dataSourceId: "aws", data: { x: 1 }, status: "success", toolErrors: [] },
			{ dataSourceId: "elastic", data: { y: 1 }, status: "success", toolErrors: [] },
		],
		...over,
	} as unknown as AgentStateType;
}

beforeEach(() => {
	process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
	process.env.KG_BINDINGS_WRITE_ENABLED = "true";
});
afterEach(() => {
	_setGraphStoreForTesting(null);
	// delete, not `= undefined`: assigning undefined stores the STRING "undefined".
	delete process.env.KNOWLEDGE_GRAPH_ENABLED;
	delete process.env.KG_BINDINGS_WRITE_ENABLED;
});

describe("isBindingsWriteEnabled", () => {
	test("default ON: false only for 'false'/'0'", () => {
		expect(isBindingsWriteEnabled({} as NodeJS.ProcessEnv)).toBe(true);
		expect(isBindingsWriteEnabled({ KG_BINDINGS_WRITE_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isBindingsWriteEnabled({ KG_BINDINGS_WRITE_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isBindingsWriteEnabled({ KG_BINDINGS_WRITE_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
		expect(isBindingsWriteEnabled({ KG_BINDINGS_WRITE_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
	});
});

describe("deriveConfirmedBindings", () => {
	test("maps confirmed datasources' identifiers to binding records", () => {
		const recs = deriveConfirmedBindings(baseState());
		expect(recs).toHaveLength(2);
		expect(recs).toContainEqual(
			expect.objectContaining({
				service: "orders",
				datasource: "aws",
				kind: "logGroup",
				resourceId: "/ecs/orders-prd",
				confidence: 0.7,
			}),
		);
		expect(recs).toContainEqual(
			expect.objectContaining({
				service: "orders",
				datasource: "elastic",
				kind: "serviceName",
				resourceId: "orders-api",
			}),
		);
	});

	test("no fresh resolution / no focus / stale stamp -> []", () => {
		expect(deriveConfirmedBindings(baseState({ resolvedIdentifiers: undefined }))).toEqual([]);
		expect(deriveConfirmedBindings(baseState({ investigationFocus: undefined }))).toEqual([]);
		// stamp mismatch: resolution answered a different service set
		const stale = baseState();
		(stale.resolvedIdentifiers as ResolvedIdentifiers).resolvedForServices = ["payments"];
		expect(deriveConfirmedBindings(stale)).toEqual([]);
	});

	test("multi-service focus is skipped in Stage 1 (no per-service attribution yet)", () => {
		const multi = baseState({
			investigationFocus: {
				services: ["orders", "payments"],
				datasources: ["aws"],
				summary: "multi",
				establishedAtTurn: 1,
			},
		});
		// stamp must still match to reach the multi-service guard
		(multi.resolvedIdentifiers as ResolvedIdentifiers).resolvedForServices = ["orders", "payments"];
		expect(deriveConfirmedBindings(multi)).toEqual([]);
	});

	test("a degrading error blocks that datasource's bindings; no-data does not", () => {
		// aws had an auth error (degrading) -> its logGroup is NOT confirmed.
		// elastic had a no-data error (routine) -> its serviceName IS confirmed.
		const s = baseState({
			dataSourceResults: [
				{
					dataSourceId: "aws",
					data: {},
					status: "success",
					toolErrors: [{ toolName: "t", category: "auth", message: "x", retryable: false }],
				},
				{
					dataSourceId: "elastic",
					data: {},
					status: "success",
					toolErrors: [{ toolName: "t", category: "no-data", message: "x", retryable: false }],
				},
			] as AgentStateType["dataSourceResults"],
		});
		const recs = deriveConfirmedBindings(s);
		expect(recs.some((r) => r.datasource === "aws")).toBe(false);
		expect(recs.some((r) => r.datasource === "elastic")).toBe(true);
	});

	test("a datasource that did not succeed is not confirmed", () => {
		const s = baseState({
			dataSourceResults: [
				{ dataSourceId: "aws", data: {}, status: "error", toolErrors: [] },
				{ dataSourceId: "elastic", data: {}, status: "success", toolErrors: [] },
			] as AgentStateType["dataSourceResults"],
		});
		const recs = deriveConfirmedBindings(s);
		expect(recs.some((r) => r.datasource === "aws")).toBe(false);
		expect(recs.some((r) => r.datasource === "elastic")).toBe(true);
	});
});

describe("recordConfirmedBindings node", () => {
	test("flag off -> {} and zero store calls", async () => {
		process.env.KG_BINDINGS_WRITE_ENABLED = "false";
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		expect(await recordConfirmedBindings(baseState())).toEqual({});
		expect(store.calls).toHaveLength(0);
	});

	test("KG disabled -> {} and zero store calls", async () => {
		delete process.env.KNOWLEDGE_GRAPH_ENABLED;
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		expect(await recordConfirmedBindings(baseState())).toEqual({});
		expect(store.calls).toHaveLength(0);
	});

	test("enabled + confirmed -> MERGEs bindings into the graph", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const out = await recordConfirmedBindings(baseState());
		expect(out).toEqual({});
		// hasBinding gate runs (count query), then the OBSERVED_IN write
		expect(store.calls.some((c) => c.cypher.includes("OBSERVED_IN"))).toBe(true);
		expect(store.calls.some((c) => c.cypher.includes("MERGE (t:TelemetrySource"))).toBe(true);
	});

	test("nothing confirmed -> no store writes", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		const s = baseState({ resolvedIdentifiers: undefined });
		expect(await recordConfirmedBindings(s)).toEqual({});
		expect(store.calls).toHaveLength(0);
	});

	test("soft-fails to partialFailures when the store throws", async () => {
		const store = new InMemoryGraphStore();
		store.run = async () => {
			throw new Error("boom");
		};
		_setGraphStoreForTesting(store);
		const out = await recordConfirmedBindings(baseState());
		expect(out.partialFailures).toEqual([{ node: "recordBindings", reason: "graph-write-failed" }]);
	});
});

// SIO-1102: identifier-level confirmation.
describe("identifierUsedInToolCalls (SIO-1102)", () => {
	function result(over: Partial<DataSourceResult>): DataSourceResult {
		return { dataSourceId: "elastic", data: {}, status: "success", toolErrors: [], ...over } as DataSourceResult;
	}

	test("true when the identifier appears in a tool output (string or object rawJson)", () => {
		expect(
			identifierUsedInToolCalls(
				"orders-api",
				result({ toolOutputs: [{ toolName: "t", rawJson: { hits: ["orders-api"] } }] }),
			),
		).toBe(true);
		expect(
			identifierUsedInToolCalls(
				"/ecs/orders",
				result({ toolOutputs: [{ toolName: "t", rawJson: "log group /ecs/orders" }] }),
			),
		).toBe(true);
		// case-insensitive
		expect(
			identifierUsedInToolCalls(
				"ORDERS-API",
				result({ toolOutputs: [{ toolName: "t", rawJson: { x: "orders-api" } }] }),
			),
		).toBe(true);
	});

	test("false when the identifier is absent from all tool outputs", () => {
		expect(
			identifierUsedInToolCalls(
				"orders-ghost",
				result({ toolOutputs: [{ toolName: "t", rawJson: { hits: ["orders-api"] } }] }),
			),
		).toBe(false);
	});

	test("null when there are no tool outputs to judge against (caller falls back)", () => {
		expect(identifierUsedInToolCalls("orders-api", result({ toolOutputs: [] }))).toBeNull();
		expect(identifierUsedInToolCalls("orders-api", result({ toolOutputs: undefined }))).toBeNull();
		expect(identifierUsedInToolCalls("orders-api", undefined)).toBeNull();
	});

	test("empty identifier is never used", () => {
		expect(identifierUsedInToolCalls("", result({ toolOutputs: [{ toolName: "t", rawJson: "anything" }] }))).toBe(
			false,
		);
	});
});

describe("deriveConfirmedBindings identifier-level tightening (SIO-1102)", () => {
	function state(over: {
		resolved: AgentStateType["resolvedIdentifiers"];
		results: DataSourceResult[];
	}): AgentStateType {
		return {
			requestId: "req-1",
			investigationFocus: { services: ["orders"], datasources: ["elastic"], summary: "x", establishedAtTurn: 1 },
			resolvedIdentifiers: over.resolved,
			dataSourceResults: over.results,
		} as unknown as AgentStateType;
	}

	test("drops a resolved identifier that never appears in a tool output", () => {
		const recs = deriveConfirmedBindings(
			state({
				resolved: {
					resolvedForTurn: 1,
					resolvedForServices: ["orders"],
					elastic: { serviceNames: ["orders-api", "orders-ghost"] },
				},
				results: [
					{
						dataSourceId: "elastic",
						data: {},
						status: "success",
						toolErrors: [],
						toolOutputs: [{ toolName: "s", rawJson: { hits: ["orders-api"] } }],
					} as DataSourceResult,
				],
			}),
		);
		expect(recs.map((r) => r.resourceId)).toEqual(["orders-api"]);
	});

	test("keeps identifiers used in THIS datasource's tool calls, not another's", () => {
		const recs = deriveConfirmedBindings(
			state({
				resolved: {
					resolvedForTurn: 1,
					resolvedForServices: ["orders"],
					elastic: { serviceNames: ["orders-api"] },
					aws: { logGroups: ["/ecs/orders"] },
				},
				results: [
					// elastic output mentions the aws log group but NOT its own service name ->
					// elastic's orders-api is dropped; aws's /ecs/orders is confirmed by aws's output
					{
						dataSourceId: "elastic",
						data: {},
						status: "success",
						toolErrors: [],
						toolOutputs: [{ toolName: "s", rawJson: { note: "/ecs/orders" } }],
					} as DataSourceResult,
					{
						dataSourceId: "aws",
						data: {},
						status: "success",
						toolErrors: [],
						toolOutputs: [{ toolName: "q", rawJson: { group: "/ecs/orders" } }],
					} as DataSourceResult,
				],
			}),
		);
		expect(recs.map((r) => `${r.datasource}:${r.resourceId}`).sort()).toEqual(["aws:/ecs/orders"]);
	});

	test("falls back to datasource-level when a confirmed datasource has no tool outputs", () => {
		const recs = deriveConfirmedBindings(
			state({
				resolved: { resolvedForTurn: 1, resolvedForServices: ["orders"], elastic: { serviceNames: ["orders-api"] } },
				results: [
					{ dataSourceId: "elastic", data: {}, status: "success", toolErrors: [], toolOutputs: [] } as DataSourceResult,
				],
			}),
		);
		expect(recs.map((r) => r.resourceId)).toEqual(["orders-api"]);
	});
});
