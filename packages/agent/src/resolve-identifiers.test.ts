// packages/agent/src/resolve-identifiers.test.ts

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
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
	getGitlabResolutionGroup,
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

	// SIO-1261: the probe used a GLOBAL project search, contradicting project-resolution/SKILL.md's
	// categorical "group-scoped search, never global search -- global project search returns
	// unrelated public repos". It matters more since SIO-1258 made this id AUTHORITATIVE: the
	// sub-agent skips its own resolution when the focus block carries one.
	test("gitlab probe scopes the search to the resolution group", async () => {
		const seen: Array<Record<string, unknown>> = [];
		toolRegistry.gitlab = [
			{
				name: "gitlab_search",
				invoke: async (args: unknown) => {
					seen.push(args as Record<string, unknown>);
					return JSON.stringify([
						{ id: 41051769, name: "order-service", path_with_namespace: "pvhcorp/b2b/oit/order-service" },
					]);
				},
			},
		];
		await resolveIdentifiers(makeState({ targetDataSources: ["gitlab"] }));
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ scope: "projects", group_id: "pvhcorp" });
	});

	// SIO-1261: group-scoping alone did NOT fix this ticket. The term was longestToken(), and
	// tokenize() runs normalize(), whose SUFFIX_PATTERN strips `-service` -- so `order-service`
	// searched for `order`. Measured live 2026-07-28 in group pvhcorp: `order` ranks
	// `pvhcorp/membership-and-loyalty/ddm/microservices/order` FIRST and the correct
	// `pvhcorp/b2b/oit/order-service` fifth. The no-fallback guard does not save it, because the
	// wrong repo genuinely passes matchesFocus.
	test("gitlab probe searches the full service name, not the suffix-stripped token", async () => {
		const seen: Array<Record<string, unknown>> = [];
		toolRegistry.gitlab = [
			{
				name: "gitlab_search",
				invoke: async (args: unknown) => {
					seen.push(args as Record<string, unknown>);
					return JSON.stringify([]);
				},
			},
		];
		await resolveIdentifiers(makeState({ targetDataSources: ["gitlab"] }));
		expect(seen[0]).toMatchObject({ search: "order-service" });
		expect(seen[0]?.search).not.toBe("order");
	});

	// The live ranking for `order-service` in group pvhcorp, in order. Rows 2 and 3 are real repos
	// that BOTH pass matchesFocus, so without an exact-match preference the winner is whatever
	// GitLab's relevance score happened to put first.
	test("gitlab probe prefers an exact name match over a fuzzier higher-ranked row", async () => {
		toolRegistry.gitlab = [
			{
				name: "gitlab_search",
				invoke: async () =>
					JSON.stringify([
						{
							id: 41051854,
							name: "orders-service-legacy",
							path_with_namespace: "pvhcorp/b2b/oit/orders-service-legacy",
						},
						{
							id: 80424402,
							name: "pvh-ecomm-order-services",
							path_with_namespace: "pvhcorp/nara/pvh-ecomm-order-services",
						},
						{ id: 48543975, name: "order-service", path_with_namespace: "pvhcorp/b2b/oit/order-service" },
					]),
			},
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["gitlab"] }));
		expect(result.resolvedIdentifiers?.gitlab).toEqual({
			projectId: "48543975",
			pathWithNamespace: "pvhcorp/b2b/oit/order-service",
		});
	});

	// SIO-1261: the old code fell back to `rows[0]` when nothing matched the focus, so a global
	// search returning an unrelated repo made THAT repo authoritative. Returning nothing is the
	// correct outcome -- the sub-agent's own STEP 1 then resolves it with the full skill logic.
	test("gitlab probe returns nothing rather than adopting an unmatched project", async () => {
		toolRegistry.gitlab = [
			{
				name: "gitlab_search",
				invoke: async () =>
					JSON.stringify([
						{ id: 999, name: "totally-unrelated", path_with_namespace: "someone-else/totally-unrelated" },
					]),
			},
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["gitlab"] }));
		expect(result.resolvedIdentifiers?.gitlab).toBeUndefined();
	});

	// SIO-1279: an empty targetDeployments used to mean ONE probe against the MCP default
	// cluster. eu-b2b is third in ELASTIC_DEPLOYMENTS, so an unscoped order-service
	// incident probed eu-cld -- which holds zero *order* services -- and reported absence.
	test("elastic probe fans out across every configured deployment when none is targeted", async () => {
		// Capture the ALS-scoped deployment each invocation runs under, so this asserts
		// distinct clusters were probed rather than merely counting calls.
		const seen: string[] = [];
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async () => {
					seen.push(realBridge.currentElasticDeploymentForTest() ?? "(default)");
					return elasticAggPayload([]);
				},
			},
		];
		const prev = process.env.ELASTIC_DEPLOYMENTS;
		process.env.ELASTIC_DEPLOYMENTS = "eu-cld,us-cld,eu-b2b";
		try {
			await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }));
		} finally {
			if (prev === undefined) delete process.env.ELASTIC_DEPLOYMENTS;
			else process.env.ELASTIC_DEPLOYMENTS = prev;
		}
		// One warm-up + one probe per deployment. The exact count is less important than
		// the fact that a single default-cluster probe is no longer what happens.
		// warmElasticDeployments fires an unscoped warm-up first (SIO-1086), which is why
		// "(default)" also appears; assert the fan-out is a SUPERSET of the configured list
		// rather than pinning the warm-up's presence.
		for (const id of ["eu-cld", "us-cld", "eu-b2b"]) {
			expect(seen, `deployment ${id} was never probed`).toContain(id);
		}
	});

	// SIO-1279 (CodeRabbit on PR #522): warmElasticDeployments must select the SAME
	// deployments as probeElastic. Warming only the default cluster left the other N-1 to
	// pay their uncancellable session-fork connect inside the timed probe -- the exact
	// failure SIO-1086 added the warm-up to prevent. Observed as a 117s elastic sub-agent
	// on the first fan-out run. Pin the two together so they cannot drift again.
	// CodeRabbit on PR #522: two membership arrays only prove the sets overlap. A
	// regression that ran the probe BEFORE the warm-up, or warmed extra stale
	// deployments, would still pass -- while the warm-up exists precisely to land FIRST.
	// Record an ordered event log and assert both the exact set equality and the ordering.
	test("every probed deployment is warmed BEFORE the first probe", async () => {
		const events: Array<{ phase: "warm" | "probe"; deployment: string }> = [];
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async (args: unknown) => {
					// The warm-up is the terminate_after:1 match_all; everything else is the probe.
					const phase = JSON.stringify(args ?? {}).includes("terminate_after") ? "warm" : "probe";
					events.push({ phase, deployment: realBridge.currentElasticDeploymentForTest() ?? "(default)" });
					return elasticAggPayload([]);
				},
			},
		];
		const prev = process.env.ELASTIC_DEPLOYMENTS;
		process.env.ELASTIC_DEPLOYMENTS = "eu-cld,us-cld,eu-b2b";
		try {
			await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }));
		} finally {
			if (prev === undefined) delete process.env.ELASTIC_DEPLOYMENTS;
			else process.env.ELASTIC_DEPLOYMENTS = prev;
		}

		const probed = new Set(events.filter((e) => e.phase === "probe").map((e) => e.deployment));
		const warmed = new Set(events.filter((e) => e.phase === "warm").map((e) => e.deployment));
		const firstProbeAt = events.findIndex((e) => e.phase === "probe");
		expect(firstProbeAt, "the probe never ran, so this test proves nothing").toBeGreaterThan(-1);

		// The SAME selection, not merely overlapping: warming a deployment the probe never
		// queries is drift too, just in the other direction.
		expect(warmed, "warm-up and probe must select the same deployments").toEqual(probed);

		// And every warm-up must LAND before the timed probe opens, or the connect it
		// exists to pay for is paid inside PROBE_TIMEOUT_MS after all.
		const warmedBeforeFirstProbe = new Set(
			events
				.slice(0, firstProbeAt)
				.filter((e) => e.phase === "warm")
				.map((e) => e.deployment),
		);
		for (const dep of probed) {
			expect(
				warmedBeforeFirstProbe.has(dep),
				`${dep} was probed but not warmed beforehand -- its session-fork connect is paid inside PROBE_TIMEOUT_MS`,
			).toBe(true);
		}
	});

	// SIO-1279: every deployment carries dev/stg/prd traffic, so the sub-agent needs the
	// environment mix per candidate -- a prod symptom explained by a dev document is a
	// silently wrong conclusion.
	test("elastic probe records the deployment and environments each name was found in", async () => {
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async () =>
					JSON.stringify({
						aggregations: {
							by_service: {
								buckets: [
									{
										key: "prana-order-service",
										doc_count: 100,
										env: {
											buckets: [
												{ key: "production", doc_count: 70 },
												{ key: "development", doc_count: 30 },
											],
										},
									},
								],
							},
						},
					}),
			},
		];
		const prev = process.env.ELASTIC_DEPLOYMENTS;
		process.env.ELASTIC_DEPLOYMENTS = "eu-b2b";
		try {
			const result = await resolveIdentifiers(makeState({ targetDataSources: ["elastic"] }));
			const placements = result.resolvedIdentifiers?.elastic?.placements ?? [];
			expect(placements).toHaveLength(1);
			expect(placements[0]?.serviceName).toBe("prana-order-service");
			expect(placements[0]?.deployment).toBe("eu-b2b");
			expect(placements[0]?.environments).toEqual(["production", "development"]);
		} finally {
			if (prev === undefined) delete process.env.ELASTIC_DEPLOYMENTS;
			else process.env.ELASTIC_DEPLOYMENTS = prev;
		}
	});

	// SIO-1326: live-verified via the MCP steering audit runbook -- eu-b2b's discovery agg
	// took 9.4s against the 8s shared budget, and because ONE outer safeProbe() timeout used
	// to wrap the whole Promise.allSettled fan-out, that single slow deployment discarded the
	// OTHER deployments' already-correct results too. The fix times each deployment branch
	// individually, so a slow/hung deployment degrades to "missing that deployment's
	// candidates" (a rejected settlement) while the fast deployments' real answers survive.
	test("a slow deployment does not erase the OTHER deployments' already-resolved candidates", async () => {
		const prevTimeout = process.env.RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS;
		const prevDeployments = process.env.ELASTIC_DEPLOYMENTS;
		process.env.RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS = "30";
		process.env.ELASTIC_DEPLOYMENTS = "eu-cld,eu-b2b";
		// SIO-1326 (CodeRabbit on PR #559): record every deployment actually probed, not just
		// which one's data survived -- a regression that skipped eu-b2b's branch entirely (rather
		// than probing it and losing the race) would still pass an assertion on eu-cld alone.
		const probedDeployments: string[] = [];
		toolRegistry.elastic = [
			{
				name: "elasticsearch_search",
				invoke: async (args: unknown) => {
					// warm-up (terminate_after) always resolves fast, regardless of deployment.
					if (JSON.stringify(args ?? {}).includes("terminate_after")) return elasticAggPayload([]);
					const deployment = realBridge.currentElasticDeploymentForTest();
					probedDeployments.push(deployment ?? "(default)");
					if (deployment === "eu-b2b") {
						// Slower than the 30ms test budget -- must settle as rejected, not hang the test.
						await new Promise((resolve) => setTimeout(resolve, 200));
						return elasticAggPayload(["pvh-services-styles-v3"]);
					}
					return elasticAggPayload(["order-service"]);
				},
			},
		];
		try {
			const result = await resolveIdentifiers(
				makeState({
					targetDataSources: ["elastic"],
					investigationFocus: {
						services: ["order-service"],
						datasources: [],
						summary: "order-service failing",
						establishedAtTurn: 1,
					},
				}),
			);
			// Both deployments must have actually been probed -- proves the fan-out reached
			// eu-b2b at all, not merely that it was skipped.
			expect(probedDeployments).toEqual(expect.arrayContaining(["eu-cld", "eu-b2b"]));
			// eu-cld resolved well within budget and must survive even though eu-b2b timed out.
			expect(result.resolvedIdentifiers?.elastic?.serviceNames).toContain("order-service");
			const placements = result.resolvedIdentifiers?.elastic?.placements ?? [];
			expect(placements.some((p) => p.deployment === "eu-cld")).toBe(true);
		} finally {
			if (prevTimeout === undefined) delete process.env.RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS;
			else process.env.RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS = prevTimeout;
			if (prevDeployments === undefined) delete process.env.ELASTIC_DEPLOYMENTS;
			else process.env.ELASTIC_DEPLOYMENTS = prevDeployments;
		}
	});

	// SIO-1326 (CodeRabbit on PR #559): the AWS side of the same fix -- probeAws's per-estate
	// timeout must behave identically to probeElastic's per-deployment one.
	test("AWS: a slow estate does not erase the OTHER estate's already-resolved log groups", async () => {
		const prevTimeout = process.env.RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS;
		process.env.RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS = "30";
		const probedEstates: string[] = [];
		toolRegistry.aws = [
			{
				name: "aws_logs_describe_log_groups",
				invoke: async () => {
					const estate = realBridge.currentAwsEstate();
					probedEstates.push(estate ?? "(none)");
					if (estate === "eu-slow-prd") {
						// Slower than the 30ms test budget -- must settle as rejected, not hang the test.
						await new Promise((resolve) => setTimeout(resolve, 200));
						return JSON.stringify({ logGroups: [{ logGroupName: "/ecs/order-service-slow" }] });
					}
					return JSON.stringify({ logGroups: [{ logGroupName: "/ecs/order-service" }] });
				},
			},
		];
		try {
			const result = await resolveIdentifiers(
				makeState({ targetDataSources: ["aws"], awsTargetEstates: ["eu-fast-prd", "eu-slow-prd"] }),
			);
			// Both estates must have actually been probed -- proves the fan-out reached the slow
			// one at all, not merely that it was skipped.
			expect(probedEstates).toEqual(expect.arrayContaining(["eu-fast-prd", "eu-slow-prd"]));
			// The fast estate's log group must survive even though the slow one timed out.
			expect(result.resolvedIdentifiers?.aws?.logGroups).toContain("/ecs/order-service");
		} finally {
			if (prevTimeout === undefined) delete process.env.RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS;
			else process.env.RESOLVE_IDENTIFIERS_PROBE_TIMEOUT_MS = prevTimeout;
		}
	});

	// SIO-1261 (CodeRabbit on PR #505): the group is deliberately NOT env-overridable. An override
	// would reach only the PROBE -- project-resolution/SKILL.md hard-codes `group_id: "pvhcorp"`, so
	// the sub-agent's own STEP 1 would still search pvhcorp on exactly the fallback path this ticket
	// relies on. This pins the single source of truth AND that no env var can desynchronise the two.
	test("the resolution group is fixed to pvhcorp and no env var can desynchronise it from SKILL.md", () => {
		expect(getGitlabResolutionGroup()).toBe("pvhcorp");

		const before = process.env.GITLAB_RESOLUTION_GROUP;
		process.env.GITLAB_RESOLUTION_GROUP = "other-corp";
		try {
			expect(getGitlabResolutionGroup()).toBe("pvhcorp");
		} finally {
			if (before === undefined) delete process.env.GITLAB_RESOLUTION_GROUP;
			else process.env.GITLAB_RESOLUTION_GROUP = before;
		}
	});

	// Anti-vacuity for the test above: the constant must actually match what the skill instructs,
	// or "they agree" is asserted against a value nobody reads.
	test("SKILL.md scopes its resolution search to the same group the probe uses", async () => {
		const skill = await Bun.file(
			join(import.meta.dir, "../../../agents/incident-analyzer/agents/gitlab-agent/skills/project-resolution/SKILL.md"),
		).text();
		expect(skill).toContain(`group_id: "${getGitlabResolutionGroup()}"`);
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

	// SIO-1276: a seeded service name is useless without the cluster it lives in -- the
	// sub-agent would still have no deployment to name (the rule SIO-1277 made MANDATORY).
	// The graph stores it in `locator`; record-bindings writes it, this surfaces it.
	test("applyGraphSeeds carries the graph's deployment through as a placement", () => {
		const merged: ResolvedIdentifiers = { resolvedForTurn: 1, resolvedForServices: ["order-service"] };
		applyGraphSeeds(merged, [binding({ kind: "serviceName", resourceId: "prana-order-service", locator: "eu-b2b" })]);
		expect(merged.elastic?.serviceNames).toContain("prana-order-service");
		expect(merged.elastic?.placements).toEqual([
			// environments empty on purpose: the graph records WHERE, not the env mix, which
			// is only knowable from a live probe.
			{ serviceName: "prana-order-service", deployment: "eu-b2b", environments: [] },
		]);
	});

	// A probe-confirmed name already carries a LIVE placement (with real environments).
	// A seed for the same name must not shadow it with possibly-stale graph data.
	test("a seed does not overwrite the placement a live probe already established", () => {
		const merged: ResolvedIdentifiers = {
			resolvedForTurn: 1,
			resolvedForServices: ["order-service"],
			elastic: {
				serviceNames: ["prana-order-service"],
				placements: [{ serviceName: "prana-order-service", deployment: "eu-b2b", environments: ["production"] }],
			},
		};
		applyGraphSeeds(merged, [binding({ kind: "serviceName", resourceId: "prana-order-service", locator: "us-cld" })]);
		expect(merged.elastic?.placements).toHaveLength(1);
		expect(merged.elastic?.placements?.[0]?.deployment, "the live probe's placement must win").toBe("eu-b2b");
		expect(merged.elastic?.placements?.[0]?.environments).toEqual(["production"]);
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

// SIO-1107: bucket-aware couchbase probe.
describe("SIO-1107 bucket-aware couchbase probe", () => {
	const DEFAULT_TREE = "📁 Scope: new_model\n  └─ 📄 Collection: seasonal_assignment\n";
	const OTHER_TREE = "Bucket: prices\n\n📁 Scope: pricing\n  └─ 📄 Collection: price_points\n";
	const bucketsPayload = (names: string[]) =>
		JSON.stringify({ default_bucket: "default", buckets: names.map((name) => ({ name })) });

	function indexesMd(rows: unknown[]): string {
		return `# System Indexes (${rows.length} results)\n\n\`\`\`json\n${JSON.stringify(rows)}\n\`\`\``;
	}

	test("populates defaultBucket/buckets/otherBucketScopes and passes bucket_name on the second hop", async () => {
		const scopeArgs: unknown[] = [];
		toolRegistry.couchbase = [
			{
				name: "capella_get_scopes_and_collections",
				invoke: async (args) => {
					scopeArgs.push(args);
					const a = args as Record<string, unknown> | undefined;
					return a?.bucket_name === "prices" ? OTHER_TREE : DEFAULT_TREE;
				},
			},
			{ name: "capella_get_buckets", invoke: async () => bucketsPayload(["default", "prices"]) },
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["couchbase"] }));
		const cb = result.resolvedIdentifiers?.couchbase;
		expect(cb?.scopes).toEqual({ new_model: ["seasonal_assignment"] });
		expect(cb?.defaultBucket).toBe("default");
		expect(cb?.buckets).toEqual(["default", "prices"]);
		expect(cb?.otherBucketScopes).toEqual({ prices: { pricing: ["price_points"] } });
		expect(scopeArgs).toContainEqual({ bucket_name: "prices" });
	});

	test("buckets tool absent -> couchbase block deep-equals the pre-SIO-1107 shape", async () => {
		toolRegistry.couchbase = [{ name: "capella_get_scopes_and_collections", invoke: async () => DEFAULT_TREE }];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["couchbase"] }));
		expect(result.resolvedIdentifiers?.couchbase).toEqual({ scopes: { new_model: ["seasonal_assignment"] } });
	});

	test("caps the second hop at 3 non-default buckets", async () => {
		const probed: string[] = [];
		toolRegistry.couchbase = [
			{
				name: "capella_get_scopes_and_collections",
				invoke: async (args) => {
					const a = args as Record<string, unknown> | undefined;
					if (typeof a?.bucket_name === "string") {
						probed.push(a.bucket_name);
						return "Scope: s\n  Collection: c\n";
					}
					return DEFAULT_TREE;
				},
			},
			{
				name: "capella_get_buckets",
				invoke: async () => bucketsPayload(["default", "b1", "b2", "b3", "b4", "b5"]),
			},
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["couchbase"] }));
		expect(probed).toHaveLength(3);
		expect(Object.keys(result.resolvedIdentifiers?.couchbase?.otherBucketScopes ?? {})).toEqual(["b1", "b2", "b3"]);
	});

	test("a failing per-bucket probe drops that bucket only", async () => {
		toolRegistry.couchbase = [
			{
				name: "capella_get_scopes_and_collections",
				invoke: async (args) => {
					const a = args as Record<string, unknown> | undefined;
					if (a?.bucket_name === "bad") throw new Error("bucket unreachable");
					if (a?.bucket_name === "ok") return "Scope: s_ok\n  Collection: c_ok\n";
					return DEFAULT_TREE;
				},
			},
			{ name: "capella_get_buckets", invoke: async () => bucketsPayload(["default", "ok", "bad"]) },
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["couchbase"] }));
		expect(result.resolvedIdentifiers?.couchbase?.otherBucketScopes).toEqual({ ok: { s_ok: ["c_ok"] } });
	});

	test("indexInfo is scoped to the default bucket via bucket_id", async () => {
		toolRegistry.couchbase = [
			{ name: "capella_get_scopes_and_collections", invoke: async () => DEFAULT_TREE },
			{ name: "capella_get_buckets", invoke: async () => bucketsPayload(["default", "prices"]) },
			{
				name: "capella_get_system_indexes",
				invoke: async () =>
					indexesMd([
						{
							bucket_id: "default",
							scope_id: "new_model",
							keyspace_id: "seasonal_assignment",
							state: "online",
							is_primary: true,
						},
						{
							bucket_id: "prices",
							scope_id: "pricing",
							keyspace_id: "price_points",
							state: "online",
							is_primary: true,
						},
					]),
			},
		];
		const result = await resolveIdentifiers(makeState({ targetDataSources: ["couchbase"] }));
		const indexInfo = result.resolvedIdentifiers?.couchbase?.indexInfo;
		expect(indexInfo?.new_model?.seasonal_assignment?.hasPrimary).toBe(true);
		expect(indexInfo?.pricing).toBeUndefined();
	});
});
