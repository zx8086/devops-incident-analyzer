// packages/agent/src/mitigation.deadline.test.ts
//
// SIO-739: proposeMitigation soft-fails on per-call deadline.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";

const ORIG_ENV = { ...process.env };

// Per-test control of fake Bedrock behaviour.
let llmFactoryMode: "hangBoth" | "succeedThenHang" = "hangBoth";
let callCounter = 0;

const SUCCESS_CONTENT = JSON.stringify({
	investigate: ["look here"],
	monitor: ["watch this"],
	escalate: ["page someone"],
	relatedRunbooks: [],
});

// Mock the underlying Bedrock boundary so the real invokeWithDeadline and
// DeadlineExceededError from ./llm.ts remain live. Pattern mirrors aggregator.test.ts.
mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke(_messages: BaseMessage[], config?: { signal?: AbortSignal }) {
			const shouldSucceed = llmFactoryMode === "succeedThenHang" && callCounter++ === 0;
			if (shouldSucceed) {
				return { content: SUCCESS_CONTENT };
			}
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

import { proposeMitigation } from "./mitigation.ts";
import type { AgentStateType } from "./state.ts";

beforeEach(() => {
	process.env = { ...ORIG_ENV };
	process.env.AGENT_LLM_TIMEOUT_MITIGATION_MS = "50";
	process.env.AGENT_LLM_TIMEOUT_ACTION_PROPOSAL_MS = "50";
	// SIO-739: set env vars so getAvailableActionTools() returns both tools
	// via the real path — avoids cross-file mock.module leakage.
	process.env.SLACK_BOT_TOKEN = "xoxb-test";
	process.env.SLACK_DEFAULT_CHANNEL = "#test";
	process.env.LINEAR_API_KEY = "lin_api_test";
	process.env.LINEAR_TEAM_ID = "test-team";
	process.env.LINEAR_PROJECT_ID = "test-project";
	callCounter = 0;
	llmFactoryMode = "hangBoth";
});

afterEach(() => {
	process.env = { ...ORIG_ENV };
});

// All tests below rely on severity="high" and the SLACK_*/LINEAR_* env vars
// (set in beforeEach) to ensure proposeMitigation's `shouldPropose` is true
// and Step 2 actually runs. Test 1 asserts both Step 1 and Step 2 timeouts;
// Test 2 asserts only Step 2 timeout. Both require Step 2 to execute.
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

describe("proposeMitigation soft-fail on deadline", () => {
	test("Step 1 hangs → returns empty mitigationSteps + partialFailures entry", async () => {
		llmFactoryMode = "hangBoth";
		const result = await proposeMitigation(baseState());

		expect(result.mitigationSteps).toEqual({
			investigate: [],
			monitor: [],
			escalate: [],
			relatedRunbooks: [],
		});
		expect(result.pendingActions).toEqual([]);
		expect(result.partialFailures).toEqual(expect.arrayContaining([{ node: "proposeMitigation", reason: "timeout" }]));
		expect(result.partialFailures).toEqual(
			expect.arrayContaining([{ node: "proposeMitigation.actionProposal", reason: "timeout" }]),
		);
	});

	test("Step 1 succeeds, Step 2 hangs → Step 1 results preserved + only Step 2 partialFailure", async () => {
		llmFactoryMode = "succeedThenHang";
		const result = await proposeMitigation(baseState());

		expect(result.mitigationSteps).toEqual({
			investigate: ["look here"],
			monitor: ["watch this"],
			escalate: ["page someone"],
			relatedRunbooks: [],
		});
		expect(result.pendingActions).toEqual([]);
		expect(result.partialFailures).toEqual([{ node: "proposeMitigation.actionProposal", reason: "timeout" }]);
	});

	test("test completes in under 1 second wall clock", async () => {
		llmFactoryMode = "hangBoth";
		const start = Date.now();
		await proposeMitigation(baseState());
		expect(Date.now() - start).toBeLessThan(1000);
	});
});
