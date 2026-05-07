// packages/agent/tests/correlation/engine.test.ts
import { describe, expect, test } from "bun:test";
import { evaluate } from "../../src/correlation/engine";
import { correlationRules } from "../../src/correlation/rules";
import type { AgentStateType } from "../../src/state";

function baseState(): AgentStateType {
	return {
		messages: [],
		attachmentMeta: [],
		queryComplexity: "complex",
		targetDataSources: [],
		targetDeployments: [],
		dataSourceResults: [],
		currentDataSource: "",
		extractedEntities: { dataSources: [] },
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous",
		toolPlan: [],
		validationResult: "pass",
		retryCount: 0,
		alignmentRetries: 0,
		alignmentHints: [],
		skippedDataSources: [],
		isFollowUp: false,
		finalAnswer: "",
		dataSourceContext: undefined,
		requestId: "test",
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
	} as AgentStateType;
}

function withKafkaResult(state: AgentStateType, data: unknown): AgentStateType {
	return {
		...state,
		dataSourceResults: [
			...state.dataSourceResults,
			{ dataSourceId: "kafka", status: "success", data, duration: 100 } as never,
		],
	};
}

function withElasticResult(state: AgentStateType, data: unknown): AgentStateType {
	return {
		...state,
		dataSourceResults: [
			...state.dataSourceResults,
			{ dataSourceId: "elastic", status: "success", data, duration: 100 } as never,
		],
	};
}

describe("correlation engine — kafka-empty-or-dead-groups", () => {
	test("fires when at least one Empty or Dead group exists", () => {
		const state = withKafkaResult(baseState(), {
			consumerGroups: [
				{ id: "notification-service", state: "Empty" },
				{ id: "payments-service", state: "Stable", totalLag: 0 },
			],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-empty-or-dead-groups");
		expect(rule?.status).toBe("needs-invocation");
		expect(rule?.match?.context).toEqual({ groupIds: ["notification-service"] });
	});

	test("does not fire when all groups are Stable", () => {
		const state = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "payments-service", state: "Stable", totalLag: 0 }],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-empty-or-dead-groups");
		expect(rule?.status).toBe("satisfied");
	});
});

describe("correlation engine — kafka-significant-lag", () => {
	test("fires when a Stable group has lag > 10K", () => {
		const state = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "payments-service", state: "Stable", totalLag: 50_000 }],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-significant-lag");
		expect(rule?.status).toBe("needs-invocation");
	});

	test("does not fire below threshold", () => {
		const state = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "payments-service", state: "Stable", totalLag: 100 }],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-significant-lag");
		expect(rule?.status).toBe("satisfied");
	});
});

describe("correlation engine — kafka-dlq-growth", () => {
	test("fires when any DLQ has positive recentDelta", () => {
		const state = withKafkaResult(baseState(), {
			dlqTopics: [
				{ name: "orders-dlq", totalMessages: 100, recentDelta: 5 },
				{ name: "payments-dlq", totalMessages: 999, recentDelta: 0 },
			],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-dlq-growth");
		expect(rule?.status).toBe("needs-invocation");
	});

	test("does not fire when all deltas are zero or null", () => {
		const state = withKafkaResult(baseState(), {
			dlqTopics: [
				{ name: "orders-dlq", totalMessages: 100, recentDelta: 0 },
				{ name: "sap-car-prices-dlt", totalMessages: 177_700, recentDelta: null },
			],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-dlq-growth");
		expect(rule?.status).toBe("satisfied");
	});
});

describe("correlation engine — kafka-tool-failures", () => {
	test("fires when toolErrors array is non-empty", () => {
		const state = withKafkaResult(baseState(), {
			toolErrors: [{ tool: "kafka_get_consumer_groups", code: "ECONNREFUSED" }],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-tool-failures");
		expect(rule?.status).toBe("needs-invocation");
	});
});

describe("correlation engine — idempotency", () => {
	test("rule already covered by elastic findings is satisfied", () => {
		const s1 = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "notification-service", state: "Empty" }],
		});
		const s2 = withElasticResult(s1, {
			services: [{ name: "notification-service", errorRate: 0.02 }],
		});
		const decisions = evaluate(s2, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-empty-or-dead-groups");
		expect(rule?.status).toBe("satisfied");
	});
});

describe("correlation engine — predicate errors are caught", () => {
	test("buggy predicate marks rule satisfied with reason", () => {
		const buggy = [
			{
				name: "buggy",
				description: "throws on purpose",
				trigger: () => {
					throw new Error("kaboom");
				},
				requiredAgent: "elastic-agent" as const,
				retry: { attempts: 1, timeoutMs: 1000 },
			},
		];
		const decisions = evaluate(baseState(), buggy);
		expect(decisions[0].status).toBe("satisfied");
		expect(decisions[0].reason).toContain("predicate error");
	});
});
