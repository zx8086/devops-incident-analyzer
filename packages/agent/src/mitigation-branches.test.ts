// packages/agent/src/mitigation-branches.test.ts
//
// SIO-741: per-branch success + timeout + non-deadline error coverage.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";

const ORIG_ENV = { ...process.env };

type BranchMode = "succeed" | "hang" | "throwOther";
type BranchKind = "investigate" | "monitor" | "escalate";

let mode: BranchMode = "succeed";
const capturedSystemPrompts: string[] = [];

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke(
			messages: BaseMessage[] | Array<{ role: string; content: string }>,
			config?: { signal?: AbortSignal },
		) {
			const msgArray = messages as Array<{ role?: string; content?: string }>;
			const sys = msgArray.find((m) => m?.role === "system");
			if (sys?.content) capturedSystemPrompts.push(sys.content);

			if (mode === "succeed") {
				return { content: JSON.stringify({ items: ["one", "two", "three"] }) };
			}
			if (mode === "throwOther") {
				throw new Error("upstream-explosion");
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

mock.module("./prompt-context.ts", () => ({
	getRunbookFilenames: () => [] as string[],
	getAgent: () => ({ manifest: {} }),
}));

import { proposeEscalate, proposeInvestigate, proposeMonitor } from "./mitigation-branches.ts";
import type { AgentStateType } from "./state.ts";

beforeEach(() => {
	process.env = { ...ORIG_ENV };
	capturedSystemPrompts.length = 0;
	mode = "succeed";
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

const BRANCHES: Array<{ name: BranchKind; fn: typeof proposeInvestigate; envKey: string }> = [
	{ name: "investigate", fn: proposeInvestigate, envKey: "AGENT_LLM_TIMEOUT_MITIGATE_INVESTIGATE_MS" },
	{ name: "monitor", fn: proposeMonitor, envKey: "AGENT_LLM_TIMEOUT_MITIGATE_MONITOR_MS" },
	{ name: "escalate", fn: proposeEscalate, envKey: "AGENT_LLM_TIMEOUT_MITIGATE_ESCALATE_MS" },
];

describe("mitigation branches", () => {
	for (const branch of BRANCHES) {
		describe(`${branch.name} branch`, () => {
			test("success returns a single fragment with parsed items", async () => {
				mode = "succeed";
				const result = await branch.fn(baseState());
				expect(result.mitigationFragments).toEqual([{ kind: branch.name, items: ["one", "two", "three"] }]);
				expect(result.partialFailures).toBeUndefined();
			});

			test("deadline timeout returns failed fragment + matching partialFailures entry", async () => {
				mode = "hang";
				process.env[branch.envKey] = "30";
				const result = await branch.fn(baseState());
				expect(result.mitigationFragments).toEqual([{ kind: branch.name, items: [], failed: true }]);
				expect(result.partialFailures).toEqual([{ node: `proposeMitigation.${branch.name}`, reason: "timeout" }]);
			});

			test("non-deadline error returns empty fragment without a partialFailure entry", async () => {
				mode = "throwOther";
				const result = await branch.fn(baseState());
				expect(result.mitigationFragments).toEqual([{ kind: branch.name, items: [] }]);
				expect(result.partialFailures).toBeUndefined();
			});

			test("bails out cleanly when finalAnswer is too short", async () => {
				mode = "succeed";
				const result = await branch.fn(baseState({ finalAnswer: "" }));
				expect(result.mitigationFragments).toEqual([{ kind: branch.name, items: [] }]);
			});
		});
	}

	test("each branch prompt is scoped to its own category only", async () => {
		mode = "succeed";
		await proposeInvestigate(baseState());
		const investigatePrompt = capturedSystemPrompts[0];
		expect(investigatePrompt).toContain("investigate");
		// The scoped prompt should NOT contain the other categories' RULES headlines.
		// (Word-boundary check to allow incidental mentions inside example text.)
		expect(investigatePrompt).not.toMatch(/Category: monitor/);
		expect(investigatePrompt).not.toMatch(/Category: escalate/);

		capturedSystemPrompts.length = 0;
		await proposeMonitor(baseState());
		const monitorPrompt = capturedSystemPrompts[0];
		expect(monitorPrompt).toContain("monitor");
		expect(monitorPrompt).not.toMatch(/Category: investigate/);
		expect(monitorPrompt).not.toMatch(/Category: escalate/);

		capturedSystemPrompts.length = 0;
		await proposeEscalate(baseState());
		const escalatePrompt = capturedSystemPrompts[0];
		expect(escalatePrompt).toContain("escalate");
		expect(escalatePrompt).not.toMatch(/Category: investigate/);
		expect(escalatePrompt).not.toMatch(/Category: monitor/);
	});
});
