// packages/agent/src/mitigation.deadline.test.ts
//
// SIO-739 + SIO-741: aggregateMitigation soft-fails on the Step 2 (action proposal)
// per-call deadline. Step 1 has moved into the three Send branches (covered by
// mitigation-branches.test.ts); this file now only exercises the aggregator path.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";

const ORIG_ENV = { ...process.env };

// Mock the underlying Bedrock boundary so the real invokeWithDeadline and
// DeadlineExceededError from ./llm.ts remain live. The aggregator only calls
// the action-proposal LLM, so the mock always hangs on the abort signal.
mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke(_messages: BaseMessage[], config?: { signal?: AbortSignal }) {
			return await new Promise<{ content: string }>((_resolve, reject) => {
				config?.signal?.addEventListener("abort", () => {
					const err = new Error("Aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		}
	},
}));

// Stub prompt-context so the runbook-filename lookup doesn't try to read disk.
mock.module("./prompt-context.ts", () => ({
	getRunbookFilenames: () => [] as string[],
	getAgent: () => ({ manifest: {} }),
}));

import { aggregateMitigation } from "./mitigation.ts";
import type { AgentStateType } from "./state.ts";

beforeEach(() => {
	process.env = { ...ORIG_ENV };
	process.env.AGENT_LLM_TIMEOUT_ACTION_PROPOSAL_MS = "50";
	// SIO-739: set env vars so getAvailableActionTools() returns both tools
	// via the real path — avoids cross-file mock.module leakage.
	process.env.SLACK_BOT_TOKEN = "xoxb-test";
	process.env.SLACK_DEFAULT_CHANNEL = "#test";
	process.env.LINEAR_API_KEY = "lin_api_test";
	process.env.LINEAR_TEAM_ID = "test-team";
	process.env.LINEAR_PROJECT_ID = "test-project";
});

afterEach(() => {
	process.env = { ...ORIG_ENV };
});

function baseState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		attachmentMeta: [],
		queryComplexity: "complex",
		targetDataSources: ["elastic"],
		targetDeployments: [],
		retryDeployments: [],
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
		finalAnswer: "x".repeat(200),
		dataSourceContext: undefined,
		requestId: "test-request",
		suggestions: [],
		normalizedIncident: { severity: "high" },
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		mitigationFragments: [
			{ kind: "investigate", items: ["check pod logs"] },
			{ kind: "monitor", items: ["watch kafka lag"] },
			{ kind: "escalate", items: ["page sre"] },
		],
		confidenceScore: 0.7,
		lowConfidence: false,
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		partialFailures: [],
		...overrides,
	} as AgentStateType;
}

describe("aggregateMitigation soft-fail on action-proposal deadline", () => {
	test("merges fragments into mitigationSteps even when Step 2 times out", async () => {
		const result = await aggregateMitigation(baseState());

		expect(result.mitigationSteps).toEqual({
			investigate: ["check pod logs"],
			monitor: ["watch kafka lag"],
			escalate: ["page sre"],
			relatedRunbooks: [],
		});
		expect(result.pendingActions).toEqual([]);
		expect(result.partialFailures).toEqual([{ node: "proposeMitigation.actionProposal", reason: "timeout" }]);
	});

	test("skips Step 2 when severity is low; no partialFailure", async () => {
		const state = baseState({ normalizedIncident: { severity: "low" } });
		const result = await aggregateMitigation(state);

		expect(result.mitigationSteps?.investigate).toEqual(["check pod logs"]);
		expect(result.pendingActions).toEqual([]);
		expect(result.partialFailures).toEqual([]);
	});

	test("test completes in under 1 second wall clock", async () => {
		const start = Date.now();
		await aggregateMitigation(baseState());
		expect(Date.now() - start).toBeLessThan(1000);
	});
});
