// packages/agent/src/aggregator-grounding-integration.test.ts
// SIO-1013: integration test for aggregate()-level ungrounded-blocker cap.
// Mirrors the mock seam from aggregator.test.ts. The describe block is gated
// on hasRunbooks because aggregate() calls buildOrchestratorPrompt(), which
// calls loadAgent() — requires the real agents/incident-analyzer directory.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { CAVEATS_HEADING } from "./confidence-policy.ts";

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
import { _setAggregatorLoggerForTesting, aggregate } from "./aggregator.ts";
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
			reportCaveats: [],
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
		expect(out.finalAnswer).not.toContain(CAVEATS_HEADING);
		expect(out.reportCaveats ?? []).toHaveLength(0);
	});

	test("still caps and rewrites the SIO-1085 true positive when the judge confirms", async () => {
		mockLlmOverride = TP_CONTENT;
		_setAbsenceJudgeLlmForTesting(verdictLlm([true]));

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-confirm"));
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.confidenceCap).toBe(0.59);
		expect(out.capReasons).toContain("premature-absence");
		expect(out.finalAnswer).toContain(CAVEATS_HEADING);
		expect(out.reportCaveats?.length ?? 0).toBeGreaterThan(0);
	});

	// SIO-1270 headline: a judge that never answers must change the caveat TEXT and NOTHING else.
	// Fail-closed is right for the cap and stays; it is wrong for a note that asserts a specific,
	// checkable, false statement about data the operator is then told to trust.
	test("a FAILED judge keeps the cap identical but drops the asserting caveat", async () => {
		mockLlmOverride = TP_CONTENT;
		_setAbsenceJudgeLlmForTesting({
			invoke: async () => {
				throw new Error("bedrock unavailable");
			},
		});

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-failed"));
		// Identical to the judge-confirms case above -- this is the "cap value is unchanged" pin.
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.confidenceCap).toBe(0.59);
		expect(out.capReasons).toContain("premature-absence");
		// ...and no NEW cap reason vocabulary was introduced (that would break the exact-set
		// assertion in packages/shared/src/__tests__/confidence.test.ts).
		expect(out.capReasons).not.toContain("premature-absence-unjudged");
		expect(out.finalAnswer).toContain(CAVEATS_HEADING);

		const caveat = out.reportCaveats?.find((c) => c.guard.startsWith("premature-absence-contradicted"));
		expect(caveat?.guard).toBe("premature-absence-contradicted-unjudged");
		expect(caveat?.note).not.toContain("returned data matching this claim");
		expect(caveat?.note).not.toContain("ground truth");
		expect(caveat?.note).toContain("did not complete");
	});

	// SIO-1270 (CodeRabbit, PR #513): the LOG must not out-assert the caveat. A message saying
	// the aggregator "asserted absence contradicted by returned data" while the accompanying
	// caveat says the check never completed reintroduces the unearned claim one layer down,
	// where a replay would read it as evidence the contradiction was established.
	test("a FAILED judge also produces a non-asserting log message", async () => {
		const warnings: string[] = [];
		const capture = (...args: unknown[]) => {
			const msg = args.find((a) => typeof a === "string");
			if (typeof msg === "string") warnings.push(msg);
			return undefined;
		};
		_setAggregatorLoggerForTesting({ info: capture, warn: capture, error: capture });
		try {
			mockLlmOverride = TP_CONTENT;
			_setAbsenceJudgeLlmForTesting({
				invoke: async () => {
					throw new Error("bedrock unavailable");
				},
			});
			await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-failed-log"));
		} finally {
			// The top-level afterEach already clears this (it runs even when a test throws --
			// verified), so this is belt-and-braces: it keeps the invariant local rather than
			// dependent on a hook 300 lines away. CodeRabbit, PR #513.
			_setAbsenceJudgeLlmForTesting(null);
			_setAggregatorLoggerForTesting(null);
		}
		const capLog = warnings.find((m) => m.includes("capping confidence") && m.includes("absence"));
		expect(capLog).toBeDefined();
		expect(capLog).not.toContain("asserted absence contradicted by returned data");
		expect(capLog).toContain("unadjudicated");
	});

	// The complement: when the judge DID adjudicate, the asserting wording is correct and must
	// survive -- the fix is conditional, not a blanket softening.
	test("a judge-CONFIRMED contradiction keeps the asserting log message", async () => {
		const warnings: string[] = [];
		const capture = (...args: unknown[]) => {
			const msg = args.find((a) => typeof a === "string");
			if (typeof msg === "string") warnings.push(msg);
			return undefined;
		};
		_setAggregatorLoggerForTesting({ info: capture, warn: capture, error: capture });
		try {
			mockLlmOverride = TP_CONTENT;
			_setAbsenceJudgeLlmForTesting(verdictLlm([true]));
			await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-confirmed-log"));
		} finally {
			_setAbsenceJudgeLlmForTesting(null);
			_setAggregatorLoggerForTesting(null);
		}
		const capLog = warnings.find((m) => m.includes("capping confidence") && m.includes("absence"));
		expect(capLog).toContain("asserted absence contradicted by returned data");
	});

	// SIO-1242: inverted. This used to assert the "[CORRECTION: ...]" debug string was inserted
	// INSIDE the row's last cell -- which is exactly how an internal note ended up rendering in the
	// Correlated Timeline's Severity column on run 43796e9f. The row must now survive untouched and
	// the correction must arrive as a caveat instead.
	test("leaves a table row UNMUTATED and records a caveat when the judge confirms", async () => {
		mockLlmOverride = TABLE_CONTENT;
		_setAbsenceJudgeLlmForTesting(verdictLlm([true]));

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-absence-judge-table"));
		expect(out.capReasons).toContain("premature-absence");
		const row = (out.finalAnswer ?? "").split("\n").find((l) => l.includes("StockSyncException")) ?? "";
		expect(row).not.toContain("[CORRECTION");
		expect(row.trimEnd().endsWith("|")).toBe(true);
		const caveat = out.reportCaveats?.find((c) => c.claim.includes("StockSyncException"));
		expect(caveat).toBeDefined();
		expect(out.finalAnswer).toContain(CAVEATS_HEADING);
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
		expect(out.finalAnswer).toContain(CAVEATS_HEADING);
		expect(out.reportCaveats?.length ?? 0).toBeGreaterThan(0);
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
		expect(out.finalAnswer).toContain(CAVEATS_HEADING);
		expect(out.reportCaveats?.length ?? 0).toBeGreaterThan(0);
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

	// SIO-1242: both arms of the absence guard moved to the caveat channel, so the "[SCOPE ...]"
	// suffix is now a caveat note rather than an inline append. The cap behaviour is unchanged.
	test("judge-confirmed universal claim still caps and records a SCOPE caveat", async () => {
		mockLlmOverride = UNIVERSAL_CONTENT;
		_setAbsenceJudgeLlmForTesting(overVerdictLlm([true]));

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-overgen-judge-confirm"));
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.capReasons).toContain("premature-absence");
		expect(out.finalAnswer).not.toContain("[SCOPE");
		expect(out.reportCaveats?.some((c) => c.guard === "premature-absence-overgeneralized")).toBe(true);
	});

	test("judge failure keeps the regex verdict (fail-closed: cap applies)", async () => {
		mockLlmOverride = SCOPED_ENUM_CONTENT;
		_setAbsenceJudgeLlmForTesting({ invoke: async () => ({ content: "not json at all" }) });

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-overgen-judge-fail"));
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.capReasons).toContain("premature-absence");
	});
});

// SIO-1273: run eaebc62b's 13,495-char report carried no Confidence line at all, so the cap
// machinery ran against a score of 0 and the turn shipped `confidence: 0` with
// `lowConfidence: false`. A missing line is a report-QUALITY defect and belongs in the caveats
// channel -- not a cap reason (there is no score to reduce) and never a synthesised number.
describe.skipIf(!hasRunbooks)("aggregate SIO-1273 missing confidence line", () => {
	const NO_CONFIDENCE_CONTENT =
		"### Elasticsearch\n\nThe checkout error rate rose sharply after 05:12Z and recovered by 06:30Z.\n";

	test("records a report-quality caveat when the report states no confidence", async () => {
		mockLlmOverride = NO_CONFIDENCE_CONTENT;

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-confidence-line-missing"));
		const caveat = out.reportCaveats?.find((c) => c.guard === "confidence-line-missing");
		expect(caveat).toBeDefined();
		expect(caveat?.note).toContain("did not state a confidence score");
		// The caveats section actually renders even though no absence guard fired.
		expect(out.finalAnswer).toContain(CAVEATS_HEADING);
		// No new cap-reason vocabulary: a missing line is not a reason a score was REDUCED, and
		// adding one would break the exact-set assertion in packages/shared.
		expect(out.capReasons ?? []).not.toContain("confidence-line-missing");
	});

	test("a report WITH a confidence line records no such caveat", async () => {
		mockLlmOverride = `${NO_CONFIDENCE_CONTENT}\nConfidence: 0.82`;

		const out = await aggregate(makeState([ELASTIC_RESULT], "test-confidence-line-present"));
		expect(out.reportCaveats?.some((c) => c.guard === "confidence-line-missing")).toBe(false);
		expect(out.confidenceScore).toBeCloseTo(0.82);
	});
});
