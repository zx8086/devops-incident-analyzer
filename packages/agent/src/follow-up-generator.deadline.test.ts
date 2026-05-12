// packages/agent/src/follow-up-generator.deadline.test.ts
//
// SIO-739: generateSuggestions soft-fails on per-call deadline.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";

const ORIG_ENV = { ...process.env };

// Mock the underlying Bedrock boundary so the real invokeWithDeadline and
// DeadlineExceededError from ./llm.ts remain live. Matches the pattern from
// mitigation.deadline.test.ts and aggregator.test.ts.
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

// Stub prompt-context so the runbook-filename lookup doesn't hit disk.
mock.module("./prompt-context.ts", () => ({
	getRunbookFilenames: () => [] as string[],
	getAgent: () => ({ manifest: {} }),
}));

import { generateFallbackSuggestions, generateSuggestions } from "./follow-up-generator.ts";
import type { AgentStateType } from "./state.ts";

beforeEach(() => {
	process.env = { ...ORIG_ENV };
	process.env.AGENT_LLM_TIMEOUT_FOLLOW_UP_MS = "50";
});

afterEach(() => {
	process.env = { ...ORIG_ENV };
});

function baseState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		attachmentMeta: [],
		queryComplexity: "complex",
		targetDataSources: [],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults: [
			{
				dataSourceId: "elastic",
				status: "success",
				data: "irrelevant",
				toolOutputs: [{ toolName: "elastic_cluster_health", output: "ok" }],
			},
		],
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
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		mitigationFragments: [],
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

describe("generateSuggestions soft-fail on deadline", () => {
	test("LLM hangs → returns fallback suggestions + partialFailures entry", async () => {
		const result = await generateSuggestions(baseState());

		const expectedFallback = generateFallbackSuggestions(["elastic_cluster_health"]);
		expect(result.suggestions).toEqual(expectedFallback);
		expect(result.partialFailures).toEqual([{ node: "followUp", reason: "timeout" }]);
	});

	test("test completes in under 1 second wall clock", async () => {
		const start = Date.now();
		await generateSuggestions(baseState());
		expect(Date.now() - start).toBeLessThan(1000);
	});
});
