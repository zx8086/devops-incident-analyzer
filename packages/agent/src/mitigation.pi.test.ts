// packages/agent/src/mitigation.pi.test.ts
// SIO-1635: aggregateMitigation appends the deterministic verify-with-pi cards
// after the LLM proposal step, independent of the severity gate. Severity is
// kept low here so the action-proposal LLM is never invoked.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIG_ENV = { ...process.env };

mock.module("./prompt-context.ts", () => ({
	getRunbookFilenames: () => [] as string[],
	getAgent: () => ({ manifest: {} }),
	buildOrchestratorPromptParts: () => ({ stable: "", volatile: "" }),
}));

import { aggregateMitigation } from "./mitigation.ts";
import type { AgentStateType } from "./state.ts";

beforeEach(() => {
	process.env = { ...ORIG_ENV };
	delete process.env.SLACK_BOT_TOKEN;
	delete process.env.LINEAR_API_KEY;
	delete process.env.PI_COMS_NET_SERVER_URL;
	delete process.env.PI_COMS_NET_AUTH_TOKEN;
});

afterEach(() => {
	process.env = { ...ORIG_ENV };
});

function baseState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		attachmentMeta: [],
		queryComplexity: "complex",
		targetDataSources: ["aws"],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults: [],
		awsTargetEstates: ["eu-oit-prd", "eu-shared-services-prd"],
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
		finalAnswer: `## Summary\n\n${"x".repeat(200)}`,
		dataSourceContext: undefined,
		requestId: "test-request",
		suggestions: [],
		normalizedIncident: { severity: "low" },
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		mitigationFragments: [{ kind: "investigate", items: ["check alb targets"] }],
		confidenceScore: 0.6,
		lowConfidence: false,
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		partialFailures: [],
		reportCaveats: [],
		...overrides,
	} as AgentStateType;
}

describe("aggregateMitigation pi verification cards", () => {
	test("no cards when the hub is not configured", async () => {
		const result = await aggregateMitigation(baseState());
		expect(result.pendingActions).toEqual([]);
	});

	test("one verify card per assessed estate even at low severity", async () => {
		process.env.PI_COMS_NET_SERVER_URL = "http://hub.test";
		process.env.PI_COMS_NET_AUTH_TOKEN = "tok";
		const result = await aggregateMitigation(baseState());
		const tools = (result.pendingActions ?? []).map((a) => a.tool);
		expect(tools).toEqual(["verify-with-pi", "verify-with-pi"]);
		expect((result.pendingActions ?? []).map((a) => a.params.estate)).toEqual(["eu-oit-prd", "eu-shared-services-prd"]);
		expect(result.mitigationSteps?.investigate).toEqual(["check alb targets"]);
		expect(result.partialFailures).toEqual([]);
	});

	test("no cards when the report is too short", async () => {
		process.env.PI_COMS_NET_SERVER_URL = "http://hub.test";
		process.env.PI_COMS_NET_AUTH_TOKEN = "tok";
		const result = await aggregateMitigation(baseState({ finalAnswer: "short" }));
		expect(result.pendingActions).toEqual([]);
	});
});
