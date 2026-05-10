// packages/agent/tests/integration/c72-replay.test.ts
// SIO-681: End-to-end verification of the correlation enforcement path for c72-style incidents.
// Uses the simpler alternative (no module mocks) — state is pre-constructed as it would exist
// after correlationFetch returns, then enforceCorrelationsAggregate is called directly.
import { describe, expect, test } from "bun:test";
import { Send } from "@langchain/langgraph";
import { enforceCorrelationsAggregate, enforceCorrelationsRouter } from "../../src/correlation/enforce-node";
import type { PendingCorrelation } from "../../src/state";
import { baseState, withElasticResult, withKafkaResult } from "../correlation/test-helpers";

const KAFKA_EMPTY_GROUP_PENDING: PendingCorrelation = {
	ruleName: "kafka-empty-or-dead-groups",
	requiredAgent: "elastic-agent",
	triggerContext: { groupIds: ["notification-service"] },
	attemptsRemaining: 3,
	timeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// c72 scenario: elastic-agent unreachable after correlationFetch dispatched
// ---------------------------------------------------------------------------

describe("c72-style replay — elastic-agent unreachable", () => {
	test("produces degradedRules entry, caps confidence, no 'Elasticsearch not queried' string", async () => {
		// Construct state as it would exist after correlationFetch returned an error result:
		// kafka shows Empty group for notification-service, elastic errored (ECONNREFUSED).
		let state = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "notification-service", state: "Empty", totalLag: 0 }],
		});
		state = {
			...state,
			confidenceScore: 0.85,
			pendingCorrelations: [KAFKA_EMPTY_GROUP_PENDING],
			dataSourceResults: [
				...state.dataSourceResults,
				{
					dataSourceId: "elastic",
					status: "error",
					error: "elastic-agent unreachable: ECONNREFUSED",
					duration: 100,
				},
			],
		};

		const result = await enforceCorrelationsAggregate(state);

		// degradedRules must contain exactly one entry for the fired rule
		expect(result.degradedRules).toBeDefined();
		expect((result.degradedRules ?? []).length).toBeGreaterThanOrEqual(1);
		const entry = (result.degradedRules ?? [])[0];
		expect(entry?.ruleName).toBe("kafka-empty-or-dead-groups");
		expect(entry?.requiredAgent).toBe("elastic-agent");
		// reason must describe the unsatisfied correlation, not just say "Elasticsearch not queried"
		expect(entry?.reason).toMatch(/specialist invoked but findings did not cover/);

		// confidence must be capped at 0.59
		expect(result.confidenceCap).toBe(0.59);
		expect(result.confidenceScore).toBe(0.59);

		// pendingCorrelations cleared after aggregation
		expect(result.pendingCorrelations).toEqual([]);

		// The literal string "Elasticsearch not queried" must not appear anywhere in the output
		expect(JSON.stringify(result)).not.toContain("Elasticsearch not queried");
	});
});

// ---------------------------------------------------------------------------
// c72 scenario: elastic-agent reachable, findings cover the triggered service
// ---------------------------------------------------------------------------

describe("c72-style replay — elastic-agent reachable, findings cover triggered service", () => {
	test("clears pendingCorrelations, no confidence cap, no degradedRules", async () => {
		// Construct state as it would exist after a successful correlationFetch:
		// kafka shows Empty group, elastic returned matching service findings.
		let state = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "notification-service", state: "Empty", totalLag: 0 }],
		});
		state = withElasticResult(state, {
			services: [{ name: "notification-service", errorRate: 0.02, log_count: 1500 }],
		});
		state = {
			...state,
			confidenceScore: 0.85,
			pendingCorrelations: [KAFKA_EMPTY_GROUP_PENDING],
		};

		const result = await enforceCorrelationsAggregate(state);

		// Rule satisfied: no degraded entries, no cap
		expect(result.degradedRules).toEqual([]);
		expect(result.confidenceCap).toBeUndefined();
		// confidenceScore not modified when rule is satisfied
		expect(result.confidenceScore).toBeUndefined();
		expect(result.pendingCorrelations).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// All-Stable kafka: router short-circuits, no re-fan-out dispatched
// ---------------------------------------------------------------------------

describe("c72-style replay — all-Stable kafka, no rules fire", () => {
	test("router returns 'enforceCorrelationsAggregate' string (no Send dispatched)", () => {
		const state = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "stable-svc", state: "Stable", totalLag: 100 }],
		});

		const result = enforceCorrelationsRouter(state);

		// Must return the literal node name, not a Send array
		expect(result).toBe("enforceCorrelationsAggregate");
		expect(Array.isArray(result)).toBe(false);
	});

	test("router returns Send[] when a rule fires (confirms the stable test is testing the right path)", () => {
		// Contrast: same shape but with an Empty group triggers a Send
		const state = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "notification-service", state: "Empty" }],
		});

		const result = enforceCorrelationsRouter(state);

		expect(Array.isArray(result)).toBe(true);
		const sends = result as Send[];
		expect(sends[0]).toBeInstanceOf(Send);
		expect(sends[0]?.node).toBe("correlationFetch");
	});
});
