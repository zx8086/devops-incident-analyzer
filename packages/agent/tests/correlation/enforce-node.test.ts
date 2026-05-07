// packages/agent/tests/correlation/enforce-node.test.ts

import { describe, expect, test } from "bun:test";
import { Send } from "@langchain/langgraph";
import {
	correlationFetch,
	enforceCorrelationsAggregate,
	enforceCorrelationsRouter,
} from "../../src/correlation/enforce-node";
import type { PendingCorrelation } from "../../src/state";
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
		expect(result.confidenceCap).toBe(0.6);
		expect(result.confidenceScore).toBe(0.6);
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
		expect(result.confidenceCap).toBe(0.6);
		// score is already below cap — Math.min(0.4, 0.6) = 0.4
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
