// packages/agent/src/aggregator-grounding-integration.test.ts
// SIO-1013: integration test for aggregate()-level ungrounded-blocker cap.
// Mirrors the mock seam from aggregator.test.ts. The describe block is gated
// on hasRunbooks because aggregate() calls buildOrchestratorPrompt(), which
// calls loadAgent() — requires the real agents/incident-analyzer directory.
import { afterEach, describe, expect, mock, test } from "bun:test";

// SIO-1120: the mock LLM emits BOTH failure shapes at once:
//   1. logs:DescribeLogGroups "not permitted" -- no auth error will be observed for it (fabricated).
//   2. ec2:DescribeRouteTables "not permitted" -- a GRANTED action; the run WILL carry a real,
//      unrelated auth error (logs:StartQuery). Under the old all-or-nothing guard, that unrelated
//      auth error suppressed the WHOLE report and this fabricated EC2 bullet sailed through. The
//      per-action guard must still flag + rewrite it.
const mockLlmContent =
	"## Gaps\n\n- ECS collector logs are inaccessible: `logs:DescribeLogGroups` is not permitted for `DevOpsAgentReadOnly`.\n- Route table configuration could not be confirmed: `ec2:DescribeRouteTables` is not permitted for `DevOpsAgentReadOnly`.\n- A second real gap here.\n\nConfidence: 0.62";
// SIO-1158: per-test override read by the mock class closure at invoke time; null falls
// back to the SIO-1013 content above. The top-level afterEach resets it.
let mockLlmOverride: string | null = null;

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke() {
			return { content: mockLlmOverride ?? mockLlmContent };
		}
	},
}));

mock.module("@devops-agent/shared", () => ({
	redactPiiContent: (s: string) => s,
	DEFAULT_TOOL_RESULT_CAP_BYTES: 131_072,
}));

import { _setAbsenceJudgeLlmForTesting } from "./absence-judge.ts";
import { aggregate } from "./aggregator.ts";
import { getRunbookFilenames } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

afterEach(() => {
	_setAbsenceJudgeLlmForTesting(null);
	delete process.env.ABSENCE_JUDGE_ENABLED;
	mockLlmOverride = null;
});

const availableRunbooks = (() => {
	try {
		return getRunbookFilenames();
	} catch {
		return [];
	}
})();
const hasRunbooks = availableRunbooks.length > 0;

describe.skipIf(!hasRunbooks)("aggregate SIO-1013 ungrounded-IAM-blocker cap", () => {
	test("aggregate caps confidence and rewrites text on an ungrounded IAM gap", async () => {
		const state: Partial<AgentStateType> = {
			messages: [],
			queryComplexity: "complex",
			targetDataSources: ["aws"],
			targetDeployments: [],
			retryDeployments: [],
			dataSourceResults: [
				{
					dataSourceId: "aws",
					data: {},
					status: "success",
					toolErrors: [],
					messageCount: 5,
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
			finalAnswer: "",
			graphContext: "",
			graphBlastRadius: [],
			dataSourceContext: undefined,
			requestId: "test-grounding",
			attachmentMeta: [],
			suggestions: [],
			normalizedIncident: { affectedServices: [] },
			mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
			confidenceScore: 0,
			confidencePreCap: undefined,
			capReasons: [] as string[],
			confirmedDegradingGapBullets: [] as string[],
			rootCauseDataSources: undefined,
			degradedDataSources: [] as string[],
			confidenceCapMode: undefined,
			correlationFetchDirective: undefined,
			lowConfidence: false,
			pendingActions: [],
			actionResults: [],
			selectedRunbooks: null,
			skillsApplied: null,
			investigationFocus: undefined,
			resolvedIdentifiers: undefined,
			pendingTopicShiftPrompt: undefined,
		};

		const out = await aggregate(state as unknown as AgentStateType);
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.confidenceCap).toBe(0.59);
		expect(out.finalAnswer).not.toContain("not permitted for");
		expect(out.finalAnswer).toContain("were not retrieved");
	});

	// SIO-1120: the localcore regression, end-to-end. A REAL unrelated auth error
	// (logs:StartQuery) must NOT ground the fabricated ec2:DescribeRouteTables /
	// logs:DescribeLogGroups "not permitted" bullets. Before the per-action fix, the single
	// unrelated auth error suppressed the whole guard and both fabricated bullets shipped.
	test("caps + rewrites fabricated granted-action bullets even when an unrelated auth error exists", async () => {
		const state: Partial<AgentStateType> = {
			messages: [],
			queryComplexity: "complex",
			targetDataSources: ["aws"],
			targetDeployments: [],
			retryDeployments: [],
			dataSourceResults: [
				{
					dataSourceId: "aws",
					data: {},
					status: "success",
					// A real denial for logs:StartQuery -- an action NEITHER fabricated bullet names.
					toolErrors: [
						{
							toolName: "aws_logs_start_query",
							category: "auth",
							message: 'Update DevOpsAgentReadOnlyPolicy to include "logs:StartQuery".',
							retryable: false,
						},
					],
					messageCount: 5,
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
			finalAnswer: "",
			graphContext: "",
			graphBlastRadius: [],
			dataSourceContext: undefined,
			requestId: "test-grounding-cross-action",
			attachmentMeta: [],
			suggestions: [],
			normalizedIncident: { affectedServices: [] },
			mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
			confidenceScore: 0,
			confidencePreCap: undefined,
			capReasons: [] as string[],
			confirmedDegradingGapBullets: [] as string[],
			rootCauseDataSources: undefined,
			degradedDataSources: [] as string[],
			confidenceCapMode: undefined,
			correlationFetchDirective: undefined,
			lowConfidence: false,
			pendingActions: [],
			actionResults: [],
			selectedRunbooks: null,
			skillsApplied: null,
			investigationFocus: undefined,
			resolvedIdentifiers: undefined,
			pendingTopicShiftPrompt: undefined,
		};

		const out = await aggregate(state as unknown as AgentStateType);
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.confidenceCap).toBe(0.59);
		// Both fabricated "not permitted" bullets must be rewritten away.
		expect(out.finalAnswer).not.toContain("ec2:DescribeRouteTables` is not permitted");
		expect(out.finalAnswer).not.toContain("logs:DescribeLogGroups` is not permitted");
		expect(out.finalAnswer).toContain("were not retrieved");
	});
});

// SIO-1158: aggregate()-level absence-judge veto over the premature-absence CONTRADICTED
// arm. Fixture answers deliberately avoid Gaps sections, IAM/expiry text, Root Cause
// headings, and sweeping quantifiers so no OTHER guard fires.
function makeState(dataSourceResults: unknown[], requestId: string): AgentStateType {
	return {
		messages: [],
		queryComplexity: "complex",
		targetDataSources: ["elastic"],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults,
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
		graphContext: "",
		graphBlastRadius: [],
		dataSourceContext: undefined,
		requestId,
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: { affectedServices: [] },
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0,
		confidencePreCap: undefined,
		capReasons: [] as string[],
		confirmedDegradingGapBullets: [] as string[],
		rootCauseDataSources: undefined,
		degradedDataSources: [] as string[],
		confidenceCapMode: undefined,
		correlationFetchDirective: undefined,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		skillsApplied: null,
		investigationFocus: undefined,
		resolvedIdentifiers: undefined,
		pendingTopicShiftPrompt: undefined,
	} as unknown as AgentStateType;
}

// Elastic returned real data this turn, so every absence line below regex-flags.
const ELASTIC_RESULT = {
	dataSourceId: "elastic",
	data: {},
	status: "success",
	toolErrors: [],
	messageCount: 5,
	toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "Total results: 91, showing 5 from position 0" }],
};

// Production false positive #1's shape (identifiers genericized): a correctly-grounded,
// phrase-scoped zero-hit finding.
const FP_SCOPED_ZERO_HIT_CONTENT =
	"### Elasticsearch\n\nstyles-search-service has 56M+ log events but zero hits for the HTTP 500 phrase in its own APM error stream.\n\nConfidence: 0.84";

// The SIO-1085 true-positive shape: the claim the guard exists to catch.
const TP_CONTENT =
	"### Elasticsearch\n\norder-sync-service does not ship logs to the connected Elasticsearch cluster; 0 hits for the checkout error.\n\nConfidence: 0.8";

// Production false positive #2's shape: the flagged line is a markdown table row grounded
// in a DIFFERENT datasource (CloudWatch) that names an elastic keyword only incidentally.
const TABLE_ROW =
	"| Upstream data gap causes HTTP 500 | delivery-dates-service has no records for season 2031TEST (CloudWatch Logs, estate-b-prd) -> returns HTTP 500 -> catalog-sync-service wraps as StockSyncException (Elasticsearch APM, CloudWatch Logs estate-a-prd) |";
const TABLE_CONTENT = `| Pattern | Evidence |\n|---|---|\n${TABLE_ROW}\n\nConfidence: 0.8`;

function verdictLlm(bools: boolean[]) {
	return {
		invoke: async () => ({
			content: JSON.stringify({ verdicts: bools.map((b, index) => ({ index, contradictedByData: b, reason: "r" })) }),
		}),
	};
}

describe.skipIf(!hasRunbooks)("aggregate SIO-1158 premature-absence judge veto", () => {
	test("does not cap or annotate a judge-vetoed scoped zero-hit line (production FP 1)", async () => {
		mockLlmOverride = FP_SCOPED_ZERO_HIT_CONTENT;
		_setAbsenceJudgeLlmForTesting(verdictLlm([false]));

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-veto"));
		expect(out.confidenceScore).toBeCloseTo(0.84);
		expect(out.confidenceCap).toBeUndefined();
		expect(out.capReasons).not.toContain("premature-absence");
		expect(out.finalAnswer).not.toContain("[CORRECTION");
	});

	test("still caps and rewrites the SIO-1085 true positive when the judge confirms", async () => {
		mockLlmOverride = TP_CONTENT;
		_setAbsenceJudgeLlmForTesting(verdictLlm([true]));

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-confirm"));
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.confidenceCap).toBe(0.59);
		expect(out.capReasons).toContain("premature-absence");
		expect(out.finalAnswer).toContain("[CORRECTION");
	});

	test("inserts the correction inside the table cell when the judge confirms a table-row contradiction", async () => {
		mockLlmOverride = TABLE_CONTENT;
		_setAbsenceJudgeLlmForTesting(verdictLlm([true]));

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-table"));
		expect(out.capReasons).toContain("premature-absence");
		const row = (out.finalAnswer ?? "").split("\n").find((l) => l.includes("StockSyncException")) ?? "";
		expect(row).toContain("[CORRECTION");
		expect(row.trimEnd().endsWith("|")).toBe(true);
		expect(row.indexOf("[CORRECTION")).toBeLessThan(row.lastIndexOf("|"));
	});

	test("ABSENCE_JUDGE_ENABLED=false keeps the regex verdict and never invokes the judge", async () => {
		process.env.ABSENCE_JUDGE_ENABLED = "false";
		mockLlmOverride = FP_SCOPED_ZERO_HIT_CONTENT;
		const calls: unknown[] = [];
		_setAbsenceJudgeLlmForTesting({
			invoke: async (messages: unknown) => {
				calls.push(messages);
				return { content: JSON.stringify({ verdicts: [{ index: 0, contradictedByData: false, reason: "r" }] }) };
			},
		});

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-disabled"));
		expect(calls).toHaveLength(0);
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.capReasons).toContain("premature-absence");
		expect(out.finalAnswer).toContain("[CORRECTION");
	});

	test("a judge failure fails closed to the regex verdict", async () => {
		mockLlmOverride = FP_SCOPED_ZERO_HIT_CONTENT;
		_setAbsenceJudgeLlmForTesting({
			invoke: async () => {
				throw new Error("bedrock unavailable");
			},
		});

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-failure"));
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.capReasons).toContain("premature-absence");
		expect(out.finalAnswer).toContain("[CORRECTION");
	});
});

// SIO-1198 Part A: aggregate()-level veto over the OVERGENERALIZED arm. The regex flags
// both universal assertions and explicitly scoped enumerations; the judge separates them.
// Fixture answers avoid ABSENCE_CLAIM_RE phrasing so the contradicted arm stays silent.
const SCOPED_ENUM_CONTENT =
	"### Couchbase\n\nStyle code TH1037 is absent from all queried collections: styles.product2g, styles.variant, styles.archived_styles.\n\nConfidence: 0.82";

const UNIVERSAL_CONTENT =
	"### Pipeline\n\nThe AFS season mapping is entirely absent from all records anywhere in the pipeline.\n\nConfidence: 0.8";

function overVerdictLlm(bools: boolean[]) {
	return {
		invoke: async () => ({
			content: JSON.stringify({
				verdicts: bools.map((b, index) => ({ index, overgeneralizedAbsence: b, reason: "r" })),
			}),
		}),
	};
}

describe.skipIf(!hasRunbooks)("aggregate SIO-1198 overgeneralized-absence judge veto", () => {
	afterEach(() => {
		_setAbsenceJudgeLlmForTesting(null);
		delete process.env.ABSENCE_JUDGE_ENABLED;
	});

	test("judge-vetoed scoped enumeration does not cap or get a SCOPE suffix", async () => {
		mockLlmOverride = SCOPED_ENUM_CONTENT;
		_setAbsenceJudgeLlmForTesting(overVerdictLlm([false]));

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-overgen-judge-veto"));
		expect(out.confidenceScore).toBeCloseTo(0.82);
		expect(out.capReasons).not.toContain("premature-absence");
		expect(out.finalAnswer).not.toContain("[SCOPE");
	});

	test("judge-confirmed universal claim still caps and gets the SCOPE suffix", async () => {
		mockLlmOverride = UNIVERSAL_CONTENT;
		_setAbsenceJudgeLlmForTesting(overVerdictLlm([true]));

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-overgen-judge-confirm"));
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.capReasons).toContain("premature-absence");
		expect(out.finalAnswer).toContain("[SCOPE");
	});

	test("judge failure keeps the regex verdict (fail-closed: cap applies)", async () => {
		mockLlmOverride = SCOPED_ENUM_CONTENT;
		_setAbsenceJudgeLlmForTesting({ invoke: async () => ({ content: "not json at all" }) });

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-overgen-judge-fail"));
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.capReasons).toContain("premature-absence");
	});
});
