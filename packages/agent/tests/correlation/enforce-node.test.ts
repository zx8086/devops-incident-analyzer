// packages/agent/tests/correlation/enforce-node.test.ts

import { describe, expect, test } from "bun:test";
import { Send } from "@langchain/langgraph";
import {
	correlationFetch,
	enforceCorrelationsAggregate,
	enforceCorrelationsRouter,
} from "../../src/correlation/enforce-node";
import { agentToDataSourceId } from "../../src/correlation/engine";
import { correlationRules } from "../../src/correlation/rules";
import type { AgentStateType, PendingCorrelation } from "../../src/state";
import {
	baseState,
	withCouchbaseFindings,
	withElasticResult,
	withElasticSyntheticUp,
	withGitLabFindings,
	withKafkaFindings,
	withKafkaToolErrors,
} from "./test-helpers";

// ---------------------------------------------------------------------------
// Router tests
// ---------------------------------------------------------------------------

describe("enforceCorrelationsRouter — Send objects when rules fire", () => {
	test("returns Send[] when kafka has an Empty group", () => {
		// SIO-764: withKafkaFindings populates result.kafkaFindings; getKafkaData reads that field.
		const state = withKafkaFindings(baseState(), {
			consumerGroups: [
				{ id: "notification-service", state: "EMPTY" },
				{ id: "payments-service", state: "STABLE", totalLag: 0 },
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
		// SIO-764: withKafkaFindings populates result.kafkaFindings; getKafkaData reads that field.
		const state = withKafkaFindings(baseState(), {
			consumerGroups: [{ id: "payments-service", state: "STABLE", totalLag: 0 }],
		});
		const result = enforceCorrelationsRouter(state);
		expect(result).toBe("enforceCorrelationsAggregate");
	});
});

describe("enforceCorrelationsRouter — dedups by agent", () => {
	test("collapses multiple rules targeting the same agent into one Send", () => {
		// kafka-empty-or-dead-groups and kafka-significant-lag both target elastic-agent
		// Trigger both by having an Empty group AND a Stable group with high lag
		// SIO-764: withKafkaFindings populates result.kafkaFindings; getKafkaData reads that field.
		const state = withKafkaFindings(baseState(), {
			consumerGroups: [
				{ id: "notification-service", state: "EMPTY" },
				{ id: "payments-service", state: "STABLE", totalLag: 50_000 },
			],
		});
		const result = enforceCorrelationsRouter(state);
		expect(Array.isArray(result)).toBe(true);
		const sends = result as Send[];
		// All 4 rules target elastic-agent — must collapse to exactly 1 Send
		expect(sends.length).toBe(1);
	});
});

// SIO-1237: end-to-end through the router. The three things the cross-check needs -- that it
// dispatches at all, that it goes to ELASTIC, and that it carries the procedure -- were each
// broken before this ticket, and none of them is observable in a rules.ts unit test.
describe("enforceCorrelationsRouter — synthetic cross-check reaches elastic with its procedure", () => {
	const HOST = "ksql.prd.shared-services.eu.pvh.cloud";

	function confluent503State(): AgentStateType {
		return withKafkaToolErrors(baseState(), [
			{
				toolName: "ksql_get_server_info",
				category: "transient",
				retryable: true,
				statusCode: 503,
				hostname: HOST,
				message: `MCP error -32603: ksqlDB error 503: upstream (target=${HOST})`,
			} as never,
		]);
	}

	function syntheticSend(sends: Send[]): Send | undefined {
		return sends.find((s) => {
			const args = s.args as { pendingCorrelations?: Array<{ ruleName: string }> };
			return args.pendingCorrelations?.some((p) => p.ruleName === "infra-service-degraded-needs-synthetic-cross-check");
		});
	}

	test("a Confluent 5xx dispatches the cross-check to the elastic datasource", () => {
		const result = enforceCorrelationsRouter(confluent503State());
		expect(Array.isArray(result)).toBe(true);
		const send = syntheticSend(result as Send[]);
		expect(send).toBeDefined();
		const args = send?.args as { currentDataSource?: string } | undefined;
		// The routing fix: canonical datasource id, not a bare "-agent" suffix strip.
		expect(args?.currentDataSource).toBe("elastic");
	});

	test("the Send carries the fetchDirective naming the index, deployment and hostname", () => {
		const result = enforceCorrelationsRouter(confluent503State());
		const send = syntheticSend(result as Send[]);
		expect(send).toBeDefined();
		const args = send?.args as { correlationFetchDirective?: string } | undefined;
		const directive = args?.correlationFetchDirective;
		expect(directive).toBeDefined();
		expect(directive).toContain("synthetics-*");
		expect(directive).toContain("eu-b2b");
		expect(directive).toContain(HOST);
	});

	// The coverage half of the fix: once the monitor for that host HAS been retrieved the
	// rule is genuinely satisfied and must not re-dispatch.
	test("does not re-dispatch once a synthetic monitor for that host was retrieved", () => {
		const state = withElasticSyntheticUp(confluent503State(), HOST, "2026-07-26T12:00:00.000Z");
		const result = enforceCorrelationsRouter(state);
		const sends = Array.isArray(result) ? (result as Send[]) : [];
		expect(syntheticSend(sends)).toBeUndefined();
	});

	// Guards the trap the routing fix closed: a rule whose requiredAgent does not map to a
	// real datasource id silently falls back to elastic-agent with ALL tools bound.
	// capella-agent -> "couchbase" is the live mismatch a suffix strip gets wrong.
	test("every rule's requiredAgent maps to a known datasource id", () => {
		const known = new Set(["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian", "aws"]);
		for (const rule of correlationRules) {
			expect(known.has(agentToDataSourceId(rule.requiredAgent))).toBe(true);
		}
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
		// SIO-764: withKafkaFindings populates result.kafkaFindings; getKafkaData reads that field.
		let state = withKafkaFindings(baseState(), {
			consumerGroups: [{ id: "notification-service", state: "EMPTY" }],
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
		// SIO-764: withKafkaFindings populates result.kafkaFindings; getKafkaData reads that field.
		const state = {
			...withKafkaFindings(baseState(), {
				consumerGroups: [{ id: "notification-service", state: "EMPTY" }],
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
		// SIO-764: withKafkaFindings populates result.kafkaFindings; getKafkaData reads that field.
		const state = {
			...withKafkaFindings(baseState(), {
				consumerGroups: [{ id: "notification-service", state: "EMPTY" }],
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
		// SIO-862: dates must be RELATIVE to now -- the rule only fires within
		// DEPLOY_RUNTIME_WINDOW_MS (30 days) of the merge, so hardcoded 2026-04/05
		// dates aged out of the window and the rule stopped triggering. merged 10d
		// ago, observed 5d ago (post-merge, inside the window) keeps this stable.
		const DAY_MS = 24 * 60 * 60 * 1000;
		const merged = new Date(Date.now() - 10 * DAY_MS).toISOString();
		const observed = new Date(Date.now() - 5 * DAY_MS).toISOString();
		const stateWithGitLab = withGitLabFindings(baseState(), {
			mergedRequests: [
				{
					id: 153,
					title: "Replace OFFSET scan",
					description: "fix slow OFFSET 13000+ queries",
					merged_at: merged,
				},
			],
		});
		const state = withCouchbaseFindings(stateWithGitLab, {
			slowQueries: [
				{
					statement: "SELECT ... OFFSET 13000 LIMIT 100",
					lastExecutionTime: observed,
				},
			],
		});
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
		// SIO-862: dates must be RELATIVE to now -- the rule only fires within
		// DEPLOY_RUNTIME_WINDOW_MS (30 days) of the merge, so hardcoded 2026-04/05
		// dates aged out of the window and the rule stopped triggering. merged 10d
		// ago, observed 5d ago (post-merge, inside the window) keeps this stable.
		const DAY_MS = 24 * 60 * 60 * 1000;
		const merged = new Date(Date.now() - 10 * DAY_MS).toISOString();
		const observed = new Date(Date.now() - 5 * DAY_MS).toISOString();
		const stateWithGitLab = withGitLabFindings(baseState(), {
			mergedRequests: [
				{
					id: 153,
					title: "Replace OFFSET scan",
					description: "fix slow OFFSET 13000+ queries",
					merged_at: merged,
				},
			],
		});
		const stateWithDatastore = withCouchbaseFindings(stateWithGitLab, {
			slowQueries: [{ statement: "SELECT ... OFFSET 13000 LIMIT 100", lastExecutionTime: observed }],
		});
		const state: AgentStateType = {
			...stateWithDatastore,
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
		// SIO-764: kafkaFindings is the typed sibling read by getKafkaData; data stays as prose.
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
					data: "kafka prose summary",
					kafkaFindings: { consumerGroups: [{ id: "group-x", state: "STABLE", totalLag: 50000 }] },
					duration: 100,
				},
			],
		};
		const result = await enforceCorrelationsAggregate(state);
		expect(result.confidenceCap).toBe(0.59);
		// SIO-860: a non-skipCoverageCheck degradation no longer leaves finalAnswer
		// untouched -- the printed confidence is rewritten to the capped value so the
		// report prose matches the HITL gate. The WARNING contradiction banner is still
		// withheld (that's reserved for skipCoverageCheck rules).
		// SIO-1194: the capped line now carries the self-explaining annotation.
		expect(result.finalAnswer).toBe(
			"# Report\n\nConfidence: 0.59 (capped from evidence score 0.8 -- unresolved cross-source correlation)",
		);
		expect(result.finalAnswer).not.toContain("WARNING: unresolved cross-source contradiction");
	});
});
