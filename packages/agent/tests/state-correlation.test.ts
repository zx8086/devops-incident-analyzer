// agent/tests/state-correlation.test.ts
import { describe, expect, test } from "bun:test";
import type { AgentStateType, DegradedRule, PendingCorrelation } from "../src/state";

describe("AgentState — correlation fields", () => {
	test("degradedRules and confidenceCap are present on the state type", () => {
		const s: Pick<AgentStateType, "degradedRules" | "confidenceCap"> = {
			degradedRules: [
				{
					ruleName: "kafka-empty-or-dead-groups",
					requiredAgent: "elastic-agent",
					reason: "elastic-agent unreachable: ECONNREFUSED after 3 attempts",
					triggerContext: { groupIds: ["notification-service"] },
				},
			],
			confidenceCap: 0.59,
		};
		expect(s.degradedRules).toHaveLength(1);
		expect(s.confidenceCap).toBe(0.59);
	});

	test("pendingCorrelations type exists with the expected shape", () => {
		const p: PendingCorrelation = {
			ruleName: "kafka-dlq-growth",
			requiredAgent: "elastic-agent",
			triggerContext: { topics: [{ name: "orders-dlq", delta: 5 }] },
			attemptsRemaining: 3,
			timeoutMs: 30_000,
		};
		expect(p.attemptsRemaining).toBe(3);
	});

	test("DegradedRule type can be constructed for each AgentName variant", () => {
		const agents: DegradedRule["requiredAgent"][] = [
			"elastic-agent",
			"kafka-agent",
			"capella-agent",
			"konnect-agent",
			"gitlab-agent",
		];
		expect(agents).toHaveLength(5);
	});
});
