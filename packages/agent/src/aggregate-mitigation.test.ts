// packages/agent/src/aggregate-mitigation.test.ts
//
// SIO-741: fragment merge + selectedRunbooks reuse + failed-branch handling +
// Step 2 severity gate. Step 2 timeout coverage lives in mitigation.deadline.test.ts.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";

const ORIG_ENV = { ...process.env };

type Step2Mode = "noTools" | "emptyActions" | "twoActions";
let step2Mode: Step2Mode = "noTools";

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke(_messages: BaseMessage[]) {
			if (step2Mode === "twoActions") {
				return {
					content: JSON.stringify({
						actions: [
							{ tool: "notify-slack", params: { channel: "#x", message: "m", severity: "high" }, reason: "r" },
							{
								tool: "create-ticket",
								params: {
									title: "t",
									description: "d",
									severity: "high",
									affected_services: ["a"],
									datasources_queried: ["elastic"],
								},
								reason: "r",
							},
						],
					}),
				};
			}
			return { content: JSON.stringify({ actions: [] }) };
		}
	},
}));

mock.module("./prompt-context.ts", () => ({
	getRunbookFilenames: () => [] as string[],
	getAgent: () => ({ manifest: {} }),
}));

import { aggregateMitigation } from "./mitigation.ts";
import type { AgentStateType, MitigationFragment } from "./state.ts";

beforeEach(() => {
	process.env = { ...ORIG_ENV };
	step2Mode = "noTools";
});

afterEach(() => {
	process.env = { ...ORIG_ENV };
});

function setActionToolsEnabled() {
	process.env.SLACK_BOT_TOKEN = "xoxb-test";
	process.env.SLACK_DEFAULT_CHANNEL = "#test";
	process.env.LINEAR_API_KEY = "lin_api_test";
	process.env.LINEAR_TEAM_ID = "test-team";
	process.env.LINEAR_PROJECT_ID = "test-project";
}

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

const FRAGMENTS: MitigationFragment[] = [
	{ kind: "investigate", items: ["check logs", "verify health"] },
	{ kind: "monitor", items: ["watch lag"] },
	{ kind: "escalate", items: ["page sre"] },
];

describe("aggregateMitigation", () => {
	test("merges three fragments into the durable mitigationSteps shape", async () => {
		const result = await aggregateMitigation(baseState({ mitigationFragments: FRAGMENTS }));

		expect(result.mitigationSteps).toEqual({
			investigate: ["check logs", "verify health"],
			monitor: ["watch lag"],
			escalate: ["page sre"],
			relatedRunbooks: [],
		});
	});

	test("relatedRunbooks reuses state.selectedRunbooks when populated (no LLM call)", async () => {
		const result = await aggregateMitigation(
			baseState({
				mitigationFragments: FRAGMENTS,
				selectedRunbooks: ["knowledge/runbooks/kafka-lag.md", "knowledge/runbooks/disk-pressure.md"],
			}),
		);

		expect(result.mitigationSteps?.relatedRunbooks).toEqual([
			"knowledge/runbooks/kafka-lag.md",
			"knowledge/runbooks/disk-pressure.md",
		]);
	});

	test("relatedRunbooks falls back to [] when selectedRunbooks is null", async () => {
		const result = await aggregateMitigation(baseState({ mitigationFragments: FRAGMENTS, selectedRunbooks: null }));
		expect(result.mitigationSteps?.relatedRunbooks).toEqual([]);
	});

	test("filters out failed fragments so that category is empty in mitigationSteps", async () => {
		const fragments: MitigationFragment[] = [
			{ kind: "investigate", items: ["look at logs"] },
			{ kind: "monitor", items: [], failed: true },
			{ kind: "escalate", items: ["page sre"] },
		];

		const result = await aggregateMitigation(baseState({ mitigationFragments: fragments }));

		expect(result.mitigationSteps?.investigate).toEqual(["look at logs"]);
		expect(result.mitigationSteps?.monitor).toEqual([]);
		expect(result.mitigationSteps?.escalate).toEqual(["page sre"]);
	});

	test("skips Step 2 when severity is low even with action tools configured", async () => {
		setActionToolsEnabled();
		step2Mode = "twoActions";

		const result = await aggregateMitigation(
			baseState({ mitigationFragments: FRAGMENTS, normalizedIncident: { severity: "low" } }),
		);

		expect(result.pendingActions).toEqual([]);
		expect(result.partialFailures).toEqual([]);
	});

	test("runs Step 2 when severity is high and action tools are configured", async () => {
		setActionToolsEnabled();
		step2Mode = "twoActions";

		const result = await aggregateMitigation(
			baseState({ mitigationFragments: FRAGMENTS, normalizedIncident: { severity: "high" } }),
		);

		expect(result.pendingActions?.length).toBe(2);
		expect(result.pendingActions?.map((a) => a.tool)).toEqual(["notify-slack", "create-ticket"]);
	});

	test("returns empty mitigationSteps when finalAnswer is too short", async () => {
		const result = await aggregateMitigation(baseState({ mitigationFragments: FRAGMENTS, finalAnswer: "" }));

		expect(result.mitigationSteps).toEqual({ investigate: [], monitor: [], escalate: [], relatedRunbooks: [] });
		expect(result.pendingActions).toEqual([]);
	});
});
