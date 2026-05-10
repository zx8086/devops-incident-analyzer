// packages/agent/tests/integration/styles-v3-replay.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";

// Module-level mock: minimal LLM that returns a styles-v3-shaped aggregator output
// (defensive prose, multi-bullet Gaps section, low-information Confidence line).
// The real transcript is at LangSmith trace 019e12a4-fdc8-73c9-bdf7-8c7f1b39764b.
const STYLES_V3_REPORT = `# styles-v3 incident analysis

## Summary
The OFFSET 13000+ pattern is consistent with pre-fix behaviour. Both reports
are based on data collected prior to the failure cascade, not fabricated.

## Findings
- Couchbase: lastExecutionTime 2026-05-07T13:55:00Z, OFFSET 13000+ observed
- GitLab: MR !153 merged 2026-04-22, deploys 2026-04-23, replaces OFFSET

## Gaps
- live APM cardinality could not be re-run
- 7.5x duplication ratio is from pre-timeout sub-agent analysis
- 37.9x 7-day ratio from March cannot be confirmed or refuted
- ksql_get_server_info not available in tool environment
- Atlassian parse failures

Confidence: 0.71`;

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke(_messages: BaseMessage[]) {
			return { content: STYLES_V3_REPORT };
		}
	},
}));
mock.module("@devops-agent/shared", () => ({
	redactPiiContent: (s: string) => s,
}));

import { aggregate } from "../../src/aggregator";
import { enforceCorrelationsAggregate } from "../../src/correlation/enforce-node";
import type { AgentStateType } from "../../src/state";
import { baseState } from "../correlation/test-helpers";

const HITL_THRESHOLD = 0.6;

function styleV3State(): AgentStateType {
	const merged = new Date("2026-04-22T00:00:00Z").toISOString();
	const observed = new Date("2026-05-07T13:55:00Z").toISOString();
	return {
		...baseState(),
		targetDataSources: ["elastic", "kafka", "couchbase", "gitlab"],
		dataSourceResults: [
			{
				dataSourceId: "kafka",
				status: "success",
				data: { consumerGroups: [] },
				duration: 128036,
				messageCount: 40,
				toolErrors: Array.from({ length: 9 }, (_, i) => ({
					toolName: `kafka_tool_${i}`,
					category: "transient",
					message: "timeout",
					retryable: true,
				})),
			},
			{
				dataSourceId: "elastic",
				status: "success",
				data: "elastic ok",
				duration: 30000,
				messageCount: 27,
				toolErrors: Array.from({ length: 4 }, (_, i) => ({
					toolName: `elastic_tool_${i}`,
					category: "transient",
					message: "timeout",
					retryable: true,
				})),
			},
			{
				dataSourceId: "gitlab",
				status: "success",
				data: {
					mergedRequests: [
						{ id: 153, title: "Replace OFFSET scan", description: "fix slow OFFSET 13000+ queries", merged_at: merged },
					],
				},
				duration: 800,
			},
			{
				dataSourceId: "couchbase",
				status: "success",
				data: {
					slowQueries: [
						{ statement: "SELECT ... OFFSET 13000 LIMIT 100", lastExecutionTime: observed, serviceTime: 9900 },
					],
				},
				duration: 1200,
			},
		],
		messages: [],
	} as AgentStateType;
}

describe("styles-v3 replay: trust trio asserts cap fires end-to-end", () => {
	test("aggregate caps confidence below the HITL threshold (0.6)", async () => {
		const state = styleV3State();
		const result = await aggregate(state);
		// Score must be at most the cap (0.59) -- well below the LLM's self-reported 0.71.
		expect(result.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(result.confidenceCap).toBe(0.59);
		// Strictly below the gate threshold so checkConfidence sets lowConfidence=true.
		expect(result.confidenceScore).toBeLessThan(HITL_THRESHOLD);
	});

	test("SIO-712 contradiction rule fires and adds the banner via enforceCorrelationsAggregate", async () => {
		const state = styleV3State();
		const aggResult = await aggregate(state);
		const stateAfterAgg: AgentStateType = {
			...state,
			finalAnswer: aggResult.finalAnswer ?? "",
			confidenceScore: aggResult.confidenceScore ?? 0,
			confidenceCap: aggResult.confidenceCap,
			pendingCorrelations: [
				{
					ruleName: "gitlab-deploy-vs-datastore-runtime",
					requiredAgent: "gitlab-agent",
					triggerContext: {
						gitlabRef: 153,
						datastoreSource: "couchbase",
					},
					attemptsRemaining: 1,
					timeoutMs: 30_000,
				},
			],
		};
		const enforceResult = await enforceCorrelationsAggregate(stateAfterAgg);
		expect(enforceResult.confidenceCap).toBe(0.59);
		expect(enforceResult.finalAnswer).toContain("WARNING: unresolved cross-source contradiction");
	});
});
