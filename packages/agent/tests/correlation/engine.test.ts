// packages/agent/tests/correlation/engine.test.ts
import { describe, expect, test } from "bun:test";
import { evaluate } from "../../src/correlation/engine";
import { correlationRules } from "../../src/correlation/rules";
import {
	baseState,
	withCouchbaseFindings,
	withElasticResult,
	withGitLabFindings,
	withKafkaFindings,
	withKafkaResult,
	withKafkaToolErrors,
} from "./test-helpers";

describe("correlation engine — kafka-empty-or-dead-groups", () => {
	test("fires when at least one Empty or Dead group exists", () => {
		const state = withKafkaFindings(baseState(), {
			consumerGroups: [
				{ id: "notification-service", state: "EMPTY" },
				{ id: "payments-service", state: "STABLE", totalLag: 0 },
			],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-empty-or-dead-groups");
		expect(rule?.status).toBe("needs-invocation");
		expect(rule?.match?.context).toEqual({ groupIds: ["notification-service"] });
	});

	test("does not fire when all groups are Stable", () => {
		const state = withKafkaFindings(baseState(), {
			consumerGroups: [{ id: "payments-service", state: "STABLE", totalLag: 0 }],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-empty-or-dead-groups");
		expect(rule?.status).toBe("satisfied");
	});
});

describe("correlation engine — kafka-significant-lag", () => {
	test("fires when a Stable group has lag > 10K", () => {
		const state = withKafkaFindings(baseState(), {
			consumerGroups: [{ id: "payments-service", state: "STABLE", totalLag: 50_000 }],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-significant-lag");
		expect(rule?.status).toBe("needs-invocation");
	});

	test("does not fire below threshold", () => {
		const state = withKafkaFindings(baseState(), {
			consumerGroups: [{ id: "payments-service", state: "STABLE", totalLag: 100 }],
		});
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-significant-lag");
		expect(rule?.status).toBe("satisfied");
	});
});

describe("correlation engine — kafka-dlq-growth", () => {
	test("fires when any DLQ has positive recentDelta", () => {
		const state = withKafkaFindings(baseState(), {
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
		const state = withKafkaFindings(baseState(), {
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
	test("fires when top-level toolErrors array is non-empty", () => {
		// SIO-769: rule reads top-level result.toolErrors (ToolError[]), not the
		// nested kafkaFindings.toolErrors slot which has never been populated.
		const state = withKafkaToolErrors(baseState(), [
			{
				toolName: "kafka_get_consumer_groups",
				category: "transient",
				message: "ECONNREFUSED",
				retryable: true,
			},
		]);
		const decisions = evaluate(state, correlationRules);
		const rule = decisions.find((d) => d.rule.name === "kafka-tool-failures");
		expect(rule?.status).toBe("needs-invocation");
		expect(rule?.match?.context.toolErrors).toHaveLength(1);
	});
});

describe("correlation engine — idempotency", () => {
	test("rule already covered by elastic findings is satisfied", () => {
		const s1 = withKafkaResult(baseState(), {
			consumerGroups: [{ id: "notification-service", state: "EMPTY" }],
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

// SIO-712: deployment-vs-runtime contradiction. The styles-v3 case: GitLab MR !153
// merged mentioning "OFFSET", Couchbase finding with lastExecutionTime > merged_at on
// a query containing "OFFSET". Three-conjunction filter: timestamp window (30 days) +
// post-merge runtime + shared distinctive token.
// SIO-862: dates are RELATIVE to now via daysAgo(). The rule only fires within
// DEPLOY_RUNTIME_WINDOW_MS (30 days) of the merge, so the previous hardcoded 2026-04/05
// dates rotted out of the window and the 'fires' cases stopped triggering.
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();
describe("gitlab-deploy-vs-datastore-runtime correlation rule", () => {
	const foundRule = correlationRules.find((r) => r.name === "gitlab-deploy-vs-datastore-runtime");
	if (!foundRule) {
		throw new Error("gitlab-deploy-vs-datastore-runtime rule not registered");
	}
	const rule = foundRule;

	test("rule is registered", () => {
		expect(rule).toBeDefined();
		expect(rule.requiredAgent).toBe("gitlab-agent");
	});

	test("fires when GitLab MR merged_at + post-merge datastore observation + shared token", () => {
		const merged = daysAgo(10);
		const observed = daysAgo(5);
		const stateWithGitLab = withGitLabFindings(baseState(), {
			mergedRequests: [
				{
					id: 153,
					title: "Replace OFFSET scan with key-first subquery",
					description: "Fixes slow OFFSET 13000+ queries on styles-v3",
					merged_at: merged,
				},
			],
		});
		const state = withCouchbaseFindings(stateWithGitLab, {
			slowQueries: [
				{
					statement: "SELECT ... FROM styles ORDER BY ts OFFSET 13000 LIMIT 100",
					lastExecutionTime: observed,
				},
			],
		});
		const decisions = evaluate(state, [rule]);
		expect(decisions[0]?.status).toBe("needs-invocation");
		expect(decisions[0]?.match?.context).toMatchObject({
			gitlabRef: 153,
			datastoreSource: "couchbase",
		});
	});

	test("does NOT fire when datastore observation predates the merge", () => {
		// Observation 10d ago, merge 5d ago: observed PREDATES the merge (both in-window),
		// so the rule must not fire for the predate reason -- not because of the window.
		const merged = daysAgo(5);
		const observed = daysAgo(10);
		const stateWithGitLab = withGitLabFindings(baseState(), {
			mergedRequests: [{ id: 153, title: "Replace OFFSET scan", description: "fix", merged_at: merged }],
		});
		const state = withCouchbaseFindings(stateWithGitLab, {
			slowQueries: [{ statement: "SELECT ... OFFSET 13000", lastExecutionTime: observed }],
		});
		const decisions = evaluate(state, [rule]);
		expect(decisions[0]?.status).toBe("satisfied");
	});

	test("does NOT fire when no distinctive token is shared", () => {
		const merged = daysAgo(10);
		const observed = daysAgo(5);
		const stateWithGitLab = withGitLabFindings(baseState(), {
			mergedRequests: [{ id: 99, title: "Update README", description: "typo fix", merged_at: merged }],
		});
		const state = withCouchbaseFindings(stateWithGitLab, {
			slowQueries: [{ statement: "SELECT id FROM users", lastExecutionTime: observed }],
		});
		const decisions = evaluate(state, [rule]);
		expect(decisions[0]?.status).toBe("satisfied");
	});

	test("does NOT fire when MR merged > 30 days ago", () => {
		// Merge 45d ago is outside the 30-day DEPLOY_RUNTIME_WINDOW_MS; observation
		// 40d ago is post-merge but the window gate must still suppress the rule.
		const merged = daysAgo(45);
		const observed = daysAgo(40);
		const stateWithGitLab = withGitLabFindings(baseState(), {
			mergedRequests: [{ id: 99, title: "Replace OFFSET scan", description: "old fix", merged_at: merged }],
		});
		const state = withCouchbaseFindings(stateWithGitLab, {
			slowQueries: [{ statement: "OFFSET 13000", lastExecutionTime: observed }],
		});
		const decisions = evaluate(state, [rule]);
		expect(decisions[0]?.status).toBe("satisfied");
	});

	test("does NOT fire when GitLab data source is missing", () => {
		const observed = daysAgo(5);
		const state = withCouchbaseFindings(baseState(), {
			slowQueries: [{ statement: "OFFSET 13000", lastExecutionTime: observed }],
		});
		const decisions = evaluate(state, [rule]);
		expect(decisions[0]?.status).toBe("satisfied");
	});

	test("ignores stopwords when computing distinctive-token overlap", () => {
		const merged = daysAgo(10);
		const observed = daysAgo(5);
		const stateWithGitLab = withGitLabFindings(baseState(), {
			mergedRequests: [{ id: 99, title: "Update with the from", description: "stopwords only", merged_at: merged }],
		});
		const state = withCouchbaseFindings(stateWithGitLab, {
			slowQueries: [{ statement: "SELECT with the from", lastExecutionTime: observed }],
		});
		const decisions = evaluate(state, [rule]);
		expect(decisions[0]?.status).toBe("satisfied");
	});
});
