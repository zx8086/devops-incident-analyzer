// packages/agent/tests/correlation/enforce-node.test.ts

import { describe, expect, test } from "bun:test";
import { Send } from "@langchain/langgraph";
import {
	correlationFetch,
	enforceCorrelationsAggregate,
	enforceCorrelationsRouter,
} from "../../src/correlation/enforce-node";
import type { AgentStateType, PendingCorrelation } from "../../src/state";
import { baseState, withElasticResult, withKafkaResult } from "./test-helpers";

// ---------------------------------------------------------------------------
// Router tests
// ---------------------------------------------------------------------------

describe("enforceCorrelationsRouter — Send objects when rules fire", () => {
	test("returns Send[] when kafka has an Empty group", () => {
		const state = withKafkaResult(baseState(), {
			consumerGroups: [
				{ id: "notification-service", state: "Empty" },
				{ id: "payments-service", state: "Stable", totalLag: 0 },
			],
		});
		const result = enforceCorrelationsRouter(state);
		expect(Array.isArray(result)).toBe(true);
		const sends = result as Send[];
		expect(sends.length).toBeGreaterThanOrEqual(1);
		expect(sends[0]).toBeInstanceOf(Send);
	});
});

describe("enforceCorrelationsRouter — returns string when no rules fire", () => {
	test("returns 'enforceCorrelationsAggregate' when all groups are Stable with zero lag", () => {
		const state = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "payments-service", state: "Stable", totalLag: 0 }],
		});
		const result = enforceCorrelationsRouter(state);
		expect(result).toBe("enforceCorrelationsAggregate");
	});
});

describe("enforceCorrelationsRouter — dedups by agent", () => {
	test("collapses multiple rules targeting the same agent into one Send", () => {
		// kafka-empty-or-dead-groups and kafka-significant-lag both target elastic-agent
		// Trigger both by having an Empty group AND a Stable group with high lag
		const state = withKafkaResult(baseState(), {
			consumerGroups: [
				{ id: "notification-service", state: "Empty" },
				{ id: "payments-service", state: "Stable", totalLag: 50_000 },
			],
		});
		const result = enforceCorrelationsRouter(state);
		expect(Array.isArray(result)).toBe(true);
		const sends = result as Send[];
		// All 4 rules target elastic-agent — must collapse to exactly 1 Send
		expect(sends.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Aggregate tests
// ---------------------------------------------------------------------------

describe("enforceCorrelationsAggregate — no pending => no-op", () => {
	test("returns degradedRules: [] and confidenceCap: undefined when pendingCorrelations is empty", async () => {
		const state = { ...baseState(), pendingCorrelations: [] };
		const result = await enforceCorrelationsAggregate(state);
		expect(result.degradedRules).toEqual([]);
		expect(result.confidenceCap).toBeUndefined();
	});
});

describe("enforceCorrelationsAggregate — pending rule satisfied by elastic findings", () => {
	test("clears pendingCorrelations when elastic findings cover the triggered entities", async () => {
		const pending: PendingCorrelation[] = [
			{
				ruleName: "kafka-empty-or-dead-groups",
				requiredAgent: "elastic-agent",
				triggerContext: { groupIds: ["notification-service"] },
				attemptsRemaining: 3,
				timeoutMs: 30_000,
			},
		];
		// Kafka shows Empty group; elastic has findings for the same service
		let state = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "notification-service", state: "Empty" }],
		});
		state = withElasticResult(state, {
			services: [{ name: "notification-service", errorRate: 0.02 }],
		});
		state = { ...state, pendingCorrelations: pending };

		const result = await enforceCorrelationsAggregate(state);
		expect(result.degradedRules).toEqual([]);
		expect(result.confidenceCap).toBeUndefined();
		expect(result.pendingCorrelations).toEqual([]);
	});
});

describe("enforceCorrelationsAggregate — pending rule unsatisfied", () => {
	test("marks rule degraded and caps confidence when elastic findings are absent", async () => {
		const pending: PendingCorrelation[] = [
			{
				ruleName: "kafka-empty-or-dead-groups",
				requiredAgent: "elastic-agent",
				triggerContext: { groupIds: ["notification-service"] },
				attemptsRemaining: 3,
				timeoutMs: 30_000,
			},
		];
		// Kafka shows Empty group but NO elastic results
		const state = {
			...withKafkaResult(baseState(), {
				consumerGroups: [{ id: "notification-service", state: "Empty" }],
			}),
			confidenceScore: 0.85,
			pendingCorrelations: pending,
		};

		const result = await enforceCorrelationsAggregate(state);
		expect(result.degradedRules).toHaveLength(1);
		expect(result.degradedRules?.[0]?.ruleName).toBe("kafka-empty-or-dead-groups");
		expect(result.confidenceCap).toBe(0.59);
		expect(result.confidenceScore).toBe(0.59);
		expect(result.pendingCorrelations).toEqual([]);
	});

	test("does not raise confidenceScore when it is already below cap", async () => {
		const pending: PendingCorrelation[] = [
			{
				ruleName: "kafka-empty-or-dead-groups",
				requiredAgent: "elastic-agent",
				triggerContext: { groupIds: ["notification-service"] },
				attemptsRemaining: 3,
				timeoutMs: 30_000,
			},
		];
		const state = {
			...withKafkaResult(baseState(), {
				consumerGroups: [{ id: "notification-service", state: "Empty" }],
			}),
			confidenceScore: 0.4,
			pendingCorrelations: pending,
		};

		const result = await enforceCorrelationsAggregate(state);
		expect(result.confidenceCap).toBe(0.59);
		// score is already below cap — Math.min(0.4, 0.59) = 0.4
		expect(result.confidenceScore).toBe(0.4);
	});
});

// ---------------------------------------------------------------------------
// correlationFetch smoke test (unit: just confirms it delegates without throwing)
// ---------------------------------------------------------------------------

describe("correlationFetch — delegates to queryDataSource", () => {
	test("returns a partial AgentStateType (may include dataSourceResults array)", async () => {
		// We cannot call queryDataSource in unit tests (requires live MCP).
		// Verify the function exists and returns a promise.
		const state = { ...baseState(), currentDataSource: "elastic" };
		// correlationFetch is a thin wrapper — it will fail in unit tests because
		// the MCP bridge is not initialised. We only confirm the export exists and
		// the function signature is correct (it's async, returns a promise).
		expect(typeof correlationFetch).toBe("function");
		// Return-type guard: the function must return a Promise
		const result = correlationFetch(state);
		expect(result).toBeInstanceOf(Promise);
		// Await to avoid unhandled-rejection noise; the error is expected in unit tests
		await result.catch(() => {
			// expected: MCP bridge not initialised
		});
	});
});

// ---------------------------------------------------------------------------
// SIO-712: skipCoverageCheck routing — direct dispatch to aggregate
// ---------------------------------------------------------------------------

describe("enforceCorrelationsRouter skip-coverage routing", () => {
	test("routes skipCoverageCheck rules directly to enforceCorrelationsAggregate without a fetch", () => {
		const merged = new Date("2026-04-22T00:00:00Z").toISOString();
		const observed = new Date("2026-05-07T13:55:00Z").toISOString();
		const state = {
			...baseState(),
			dataSourceResults: [
				{
					dataSourceId: "gitlab",
					status: "success" as const,
					data: {
						mergedRequests: [
							{
								id: 153,
								title: "Replace OFFSET scan",
								description: "fix slow OFFSET 13000+ queries",
								merged_at: merged,
							},
						],
					},
					duration: 100,
				},
				{
					dataSourceId: "couchbase",
					status: "success" as const,
					data: {
						slowQueries: [
							{
								statement: "SELECT ... OFFSET 13000 LIMIT 100",
								lastExecutionTime: observed,
								serviceTime: 9900,
							},
						],
					},
					duration: 200,
				},
			],
		} as AgentStateType;
		const result = enforceCorrelationsRouter(state);
		expect(Array.isArray(result)).toBe(true);
		const sends = result as Send[];
		expect(sends).toHaveLength(1);
		const send = sends[0] as Send<string, { pendingCorrelations: PendingCorrelation[] }>;
		expect(send.node).toBe("enforceCorrelationsAggregate");
		expect(send.args.pendingCorrelations).toHaveLength(1);
		expect(send.args.pendingCorrelations[0]?.ruleName).toBe("gitlab-deploy-vs-datastore-runtime");
	});
});

describe("enforceCorrelationsAggregate banner for SIO-712 contradictions", () => {
	test("prepends WARNING banner to finalAnswer when a skipCoverageCheck rule degrades", async () => {
		const merged = new Date("2026-04-22T00:00:00Z").toISOString();
		const observed = new Date("2026-05-07T13:55:00Z").toISOString();
		const state = {
			...baseState(),
			finalAnswer: "# Incident report\n\n## Findings\n- something\n\nConfidence: 0.71",
			confidenceScore: 0.71,
			pendingCorrelations: [
				{
					ruleName: "gitlab-deploy-vs-datastore-runtime",
					requiredAgent: "gitlab-agent" as const,
					triggerContext: {
						gitlabRef: 153,
						gitlabMergedAt: merged,
						datastoreSource: "couchbase",
						datastoreObservedAt: observed,
						statementSignature: "OFFSET 13000",
					},
					attemptsRemaining: 1,
					timeoutMs: 30_000,
				},
			],
			dataSourceResults: [
				{
					dataSourceId: "gitlab",
					status: "success" as const,
					data: {
						mergedRequests: [
							{
								id: 153,
								title: "Replace OFFSET scan",
								description: "fix slow OFFSET 13000+ queries",
								merged_at: merged,
							},
						],
					},
					duration: 100,
				},
				{
					dataSourceId: "couchbase",
					status: "success" as const,
					data: {
						slowQueries: [
							{ statement: "SELECT ... OFFSET 13000 LIMIT 100", lastExecutionTime: observed, serviceTime: 9900 },
						],
					},
					duration: 200,
				},
			],
		};
		const result = await enforceCorrelationsAggregate(state);
		expect(result.confidenceCap).toBe(0.59);
		expect(result.confidenceScore).toBe(0.59);
		expect(typeof result.finalAnswer).toBe("string");
		expect(result.finalAnswer).toContain("WARNING: unresolved cross-source contradiction");
		expect(result.finalAnswer?.startsWith("WARNING: unresolved cross-source contradiction")).toBe(true);
		expect(result.finalAnswer).toContain("# Incident report");
	});

	test("does NOT prepend banner when only non-skipCoverageCheck rules degrade", async () => {
		const state = {
			...baseState(),
			finalAnswer: "# Report\n\nConfidence: 0.8",
			confidenceScore: 0.8,
			pendingCorrelations: [
				{
					ruleName: "kafka-significant-lag",
					requiredAgent: "elastic-agent" as const,
					triggerContext: { groupIds: ["group-x"], lags: [50000] },
					attemptsRemaining: 0,
					timeoutMs: 30_000,
				},
			],
			dataSourceResults: [
				{
					dataSourceId: "kafka",
					status: "success" as const,
					data: { consumerGroups: [{ id: "group-x", state: "Stable", totalLag: 50000 }] },
					duration: 100,
				},
			],
		};
		const result = await enforceCorrelationsAggregate(state);
		expect(result.confidenceCap).toBe(0.59);
		expect(result.finalAnswer).toBeUndefined();
	});
});
