// packages/agent/src/aggregator.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentStateType } from "./state.ts";

// SIO-640, SIO-635: Network-boundary mocks only. We cannot mock
// @devops-agent/gitagent-bridge or ./prompt-context.ts without causing
// cross-file test pollution (see SIO-635). Instead, capture the messages
// handed to ChatBedrockConverse.invoke() and verify the system prompt
// reflects the expected runbook filter semantics. The real loaded agent
// at agents/incident-analyzer provides the runbooks.

let lastInvokeMessages: BaseMessage[] | null = null;
// SIO-707: per-test override for the LLM response so cap-from-tool-error-rate tests
// can return a high (>0.6) confidence and verify the deterministic cap kicks in.
let mockLlmContent = "Mock aggregator output. Confidence: 0.5";

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke(messages: BaseMessage[]) {
			lastInvokeMessages = messages;
			return { content: mockLlmContent };
		}
	},
}));

mock.module("@devops-agent/shared", () => ({
	redactPiiContent: (s: string) => s,
	// SIO-833: aggregator transitively loads sub-agent-truncate-tool-output.ts, which reads
	// this constant from shared at module init; provide it so the mock namespace is complete.
	DEFAULT_TOOL_RESULT_CAP_BYTES: 131_072,
}));

import { loadAgent } from "@devops-agent/gitagent-bridge";
import {
	_setAggregatorLoggerForTesting,
	aggregate,
	aggregateResultBudget,
	appendRequestIdFooter,
	collectDegradingGapBullets,
	countDegradingGapBullets,
	extractGapsBulletCount,
	isDegradingGapBullet,
	rewriteConfidenceInAnswer,
} from "./aggregator.ts";
import { _setGapsJudgeLlmForTesting } from "./gaps-judge.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { getAgentsDir } from "./paths.ts";
import { getRunbookFilenames } from "./prompt-context.ts";

function getSystemPromptText(): string {
	if (!lastInvokeMessages || lastInvokeMessages.length === 0) return "";
	const systemMsg = lastInvokeMessages.find((m) => m._getType() === "system");
	if (!systemMsg) return "";
	// SIO-1040: the system message is now a Bedrock cache-point block array
	// ([text, cachePoint, text]) when caching is enabled, not a plain string.
	// extractTextFromContent flattens the text blocks (dropping the cache point).
	return extractTextFromContent(systemMsg.content);
}

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		queryComplexity: "complex",
		targetDataSources: ["elastic"],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults: [
			{
				dataSourceId: "elastic",
				status: "success",
				data: "result",
				duration: 100,
				toolErrors: [],
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
		requestId: "test",
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0,
		confidencePreCap: undefined,
		capReasons: [] as string[],
		confirmedDegradingGapBullets: [] as string[],
		correlationFetchDirective: undefined,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		skillsApplied: null,
		investigationFocus: undefined,
		resolvedIdentifiers: undefined,
		pendingTopicShiftPrompt: undefined,
		...overrides,
	} as AgentStateType;
}

// These tests depend on the real agents/incident-analyzer agent being loadable
// and containing at least one runbook. Skip gracefully if the agent isn't
// available in this environment.
const availableRunbooks = (() => {
	try {
		return getRunbookFilenames();
	} catch {
		return [];
	}
})();
const hasRunbooks = availableRunbooks.length > 0;
const firstRunbook = availableRunbooks[0] ?? "";

// Runbook headings in the system prompt appear as "#### <filename>" per
// gitagent-bridge's buildSystemPrompt. Match on that pattern rather than on
// the bare filename, since runbooks reference each other by filename in body
// text and we need to distinguish "runbook is included" from "runbook is
// merely mentioned by another".
function runbookHasHeading(prompt: string, filename: string): boolean {
	return prompt.includes(`#### ${filename}`);
}

describe.skipIf(!hasRunbooks)("aggregator: selectedRunbooks integration", () => {
	test("null selectedRunbooks keeps every runbook heading in the system prompt", async () => {
		lastInvokeMessages = null;
		await aggregate(makeState({ selectedRunbooks: null }));
		const prompt = getSystemPromptText();
		for (const runbook of availableRunbooks) {
			expect(runbookHasHeading(prompt, runbook)).toBe(true);
		}
	});

	test("empty array selectedRunbooks removes every runbook heading from the system prompt", async () => {
		lastInvokeMessages = null;
		await aggregate(makeState({ selectedRunbooks: [] }));
		const prompt = getSystemPromptText();
		for (const runbook of availableRunbooks) {
			expect(runbookHasHeading(prompt, runbook)).toBe(false);
		}
	});

	test("populated selectedRunbooks keeps only the named runbook heading", async () => {
		lastInvokeMessages = null;
		await aggregate(makeState({ selectedRunbooks: [firstRunbook] }));
		const prompt = getSystemPromptText();
		expect(runbookHasHeading(prompt, firstRunbook)).toBe(true);
		for (const runbook of availableRunbooks) {
			if (runbook === firstRunbook) continue;
			expect(runbookHasHeading(prompt, runbook)).toBe(false);
		}
	});
});

interface CapturedAggregatorLog {
	level: "info" | "warn" | "error";
	meta: Record<string, unknown> | undefined;
	msg: string;
}

function makeAggregatorCaptureLogger(
	captured: CapturedAggregatorLog[],
): Parameters<typeof _setAggregatorLoggerForTesting>[0] {
	const record =
		(level: CapturedAggregatorLog["level"]) =>
		(...args: unknown[]) => {
			const [first, second] = args;
			if (typeof first === "string") {
				captured.push({ level, meta: undefined, msg: first });
			} else {
				captured.push({
					level,
					meta: first as Record<string, unknown> | undefined,
					msg: typeof second === "string" ? second : "",
				});
			}
		};
	return {
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
	};
}

describe.skipIf(!hasRunbooks)("aggregate retry-coverage summary log", () => {
	test("emits info with firstAttempts when at least one datasource had a first-attempt failure", async () => {
		const captured: CapturedAggregatorLog[] = [];
		_setAggregatorLoggerForTesting(makeAggregatorCaptureLogger(captured));
		try {
			lastInvokeMessages = null;
			await aggregate(
				makeState({
					targetDataSources: ["elastic", "kafka"],
					alignmentRetries: 1,
					dataSourceResults: [
						{
							dataSourceId: "elastic",
							data: null,
							status: "error",
							duration: 202609,
							isAlignmentRetry: false,
							error: "ECONNRESET while talking to elasticsearch",
						},
						{
							dataSourceId: "elastic",
							data: "ok",
							status: "success",
							duration: 139900,
							isAlignmentRetry: true,
						},
						{
							dataSourceId: "kafka",
							data: "ok",
							status: "success",
							duration: 5000,
							isAlignmentRetry: false,
						},
					],
				}),
			);

			const summaryCall = captured.find(
				(c) => c.level === "info" && Array.isArray(c.meta?.firstAttempts) && c.meta?.firstAttemptFailureCount === 1,
			);
			expect(summaryCall).toBeDefined();
			const meta = summaryCall?.meta as {
				firstAttemptFailureCount: number;
				recoveredCount: number;
				firstAttempts: Array<{ dataSourceId: string; firstStatus: string; recovered: boolean }>;
			};
			expect(meta.firstAttemptFailureCount).toBe(1);
			expect(meta.recoveredCount).toBe(1);
			expect(meta.firstAttempts).toHaveLength(2);
		} finally {
			_setAggregatorLoggerForTesting(null);
		}
	});

	test("does NOT emit the firstAttempts info when all datasources succeeded first-try", async () => {
		const captured: CapturedAggregatorLog[] = [];
		_setAggregatorLoggerForTesting(makeAggregatorCaptureLogger(captured));
		try {
			lastInvokeMessages = null;
			await aggregate(makeState({}));
			const summaryCall = captured.find(
				(c) => c.level === "info" && typeof c.meta?.firstAttemptFailureCount === "number",
			);
			expect(summaryCall).toBeUndefined();
		} finally {
			_setAggregatorLoggerForTesting(null);
		}
	});
});

// SIO-709 (extends SIO-707): tool-error-rate confidence cap. The threshold was
// lowered from 25% to 15% because the styles-v3 transcript had a 22.5% kafka rate
// (9/40) and a 14.8% elastic rate (4/27) that previously did not cap.
describe.skipIf(!hasRunbooks)("aggregate SIO-709 tool-error-rate confidence cap", () => {
	let captured: CapturedAggregatorLog[] = [];

	beforeEach(() => {
		captured = [];
		_setAggregatorLoggerForTesting(makeAggregatorCaptureLogger(captured));
		lastInvokeMessages = null;
	});

	afterEach(() => {
		_setAggregatorLoggerForTesting(null);
		mockLlmContent = "Mock aggregator output. Confidence: 0.5";
	});

	test("caps confidence at 0.59 when toolErrorCount/messageCount > 15% (7/40 = 17.5%)", async () => {
		mockLlmContent = "Mock aggregator output. Confidence: 0.9";
		const result = await aggregate(
			makeState({
				dataSourceResults: [
					{
						dataSourceId: "kafka",
						status: "success",
						data: "result",
						duration: 128036,
						messageCount: 40,
						toolErrors: Array.from({ length: 7 }, (_, i) => ({
							toolName: `kafka_tool_${i}`,
							category: "transient",
							message: "ECONNRESET",
							retryable: true,
						})),
					},
				],
			}),
		);

		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidenceCap).toBe(0.59);
		// SIO-860: the printed confidence must match the capped gate value, not the
		// LLM's pre-cap 0.9, so the HITL banner never contradicts the report prose.
		expect(result.finalAnswer).toContain("Confidence: 0.59");
		expect(result.finalAnswer).not.toContain("Confidence: 0.9");
		const warnCall = captured.find(
			(c) => c.level === "warn" && typeof c.msg === "string" && c.msg.includes("tool-error rate exceeded threshold"),
		);
		expect(warnCall).toBeDefined();
	});

	test("caps at the styles-v3 boundary (9/40 = 22.5% kafka rate)", async () => {
		mockLlmContent = "Mock aggregator output. Confidence: 0.71";
		const result = await aggregate(
			makeState({
				dataSourceResults: [
					{
						dataSourceId: "kafka",
						status: "success",
						data: "result",
						messageCount: 40,
						toolErrors: Array.from({ length: 9 }, (_, i) => ({
							toolName: `kafka_tool_${i}`,
							category: "transient",
							message: "timeout",
							retryable: true,
						})),
					},
				],
			}),
		);
		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidenceCap).toBe(0.59);
	});

	test("does NOT cap when ratio is at or below 15% (6/40 = 15.0% boundary)", async () => {
		mockLlmContent = "Mock aggregator output. Confidence: 0.9";
		const result = await aggregate(
			makeState({
				dataSourceResults: [
					{
						dataSourceId: "kafka",
						status: "success",
						data: "result",
						messageCount: 40,
						toolErrors: Array.from({ length: 6 }, (_, i) => ({
							toolName: `kafka_tool_${i}`,
							category: "transient",
							message: "timeout",
							retryable: true,
						})),
					},
				],
			}),
		);
		expect(result.confidenceScore).toBe(0.9);
		expect(result.confidenceCap).toBeUndefined();
	});

	test("does not raise score: when LLM score is below cap, cap is not applied even if rate > 15%", async () => {
		mockLlmContent = "Mock aggregator output. Confidence: 0.4";
		const result = await aggregate(
			makeState({
				dataSourceResults: [
					{
						dataSourceId: "kafka",
						status: "success",
						data: "result",
						messageCount: 10,
						toolErrors: Array.from({ length: 3 }, () => ({
							toolName: "kafka_tool",
							category: "transient" as const,
							message: "timeout",
							retryable: true,
						})),
					},
				],
			}),
		);
		expect(result.confidenceScore).toBe(0.4);
		// confidenceCap is set whenever the cap rule triggers (rate > 15%), even if
		// the LLM score (0.4) was already below the cap value (0.59). This matches
		// the existing SIO-707/SIO-681 semantic: `confidenceCap` signals "a cap rule
		// fired", not "the score was reduced". Renaming this for clarity is out of
		// scope for SIO-709.
		expect(result.confidenceCap).toBe(0.59);
	});

	test("zero messageCount does not divide-by-zero", async () => {
		mockLlmContent = "Mock aggregator output. Confidence: 0.9";
		const result = await aggregate(
			makeState({
				dataSourceResults: [
					{
						dataSourceId: "kafka",
						status: "success",
						data: "result",
						messageCount: 0,
						toolErrors: [{ toolName: "kafka_tool", category: "transient", message: "timeout", retryable: true }],
					},
				],
			}),
		);
		expect(result.confidenceScore).toBe(0.9);
		expect(result.confidenceCap).toBeUndefined();
	});
});

describe("extractGapsBulletCount", () => {
	test("counts bullets under a top-level Gaps heading", () => {
		const report = `# Report\n\n## Findings\n- finding A\n\n## Gaps\n- gap 1\n- gap 2\n- gap 3\n\nConfidence: 0.7`;
		expect(extractGapsBulletCount(report)).toBe(3);
	});

	test("counts bullets under a level-3 Gaps heading", () => {
		const report = `### Gaps\n\n* gap one\n* gap two\n\n## Next section`;
		expect(extractGapsBulletCount(report)).toBe(2);
	});

	test("stops counting at the next heading", () => {
		const report = `## Gaps\n- one\n- two\n## Mitigation\n- not a gap\n- also not a gap`;
		expect(extractGapsBulletCount(report)).toBe(2);
	});

	test("returns 0 when no Gaps section exists", () => {
		expect(extractGapsBulletCount("## Findings\n- a\n- b")).toBe(0);
	});

	test("returns 0 for an empty Gaps section", () => {
		expect(extractGapsBulletCount("## Gaps\n\n## Confidence")).toBe(0);
	});

	test("matches Gaps heading case-insensitively", () => {
		expect(extractGapsBulletCount("## gaps\n- one\n- two")).toBe(2);
	});

	test("ignores indented sub-bullets (only top-level bullets count)", () => {
		const report = `## Gaps\n- main 1\n  - sub a\n  - sub b\n- main 2\n- main 3`;
		expect(extractGapsBulletCount(report)).toBe(3);
	});
});

// SIO-1106: the gaps cap must count only DEGRADING gap bullets (tool/query failure, auth block,
// un-runnable/unconfirmable), not routine "looked, found nothing / not applicable / not queried"
// bullets. This is the text-layer analogue of isDegradingCategory (SIO-1087).
describe("isDegradingGapBullet (SIO-1106)", () => {
	// Routine: a datasource looked and found nothing, is not applicable, or was deliberately not
	// queried. These are normal discovery outcomes and must NOT count toward the cap.
	const ROUTINE = [
		"- Kafka: no consumer-group lag data was retrieved (service is not a Kafka consumer).",
		"- Konnect: no Kong route matches prana-order-service; API-gateway telemetry not applicable.",
		"- GitLab: no recent merge requests found touching the seasons pipeline in the last 7 days.",
		"- Atlassian: no linked Jira incident ticket was found for this service.",
		"- AWS: CloudWatch metrics for the ingestion Lambda were not retrieved (out of estate scope).",
		"- Elastic: synthetic-monitor results for the order flow were not queried this turn.",
		"- couchbase seasons.dates returned 0 rows for the requested FMS key.",
	];
	// Degraded: a tool/query broke, timed out, was blocked, or a result could not be run/confirmed.
	// These are the styles-v3 class the cap exists for and MUST count.
	const DEGRADED = [
		"- live APM cardinality could not be re-run",
		"- 37.9x 7-day ratio from March cannot be confirmed or refuted",
		"- ksql_get_server_info not available in tool environment",
		"- Atlassian parse failures",
		"- Three Elasticsearch SQL queries failed during investigation (syntax and index errors).",
		"- CloudWatch Logs query timed out after 30s and could not complete.",
		"- The Kafka broker metadata endpoint was unreachable (connection refused).",
		"- logs:StartQuery returned access denied for the collector log group.",
		// CodeRabbit (PR #373): explicit authorization blocks are degrading too.
		"- CloudWatch Logs query was blocked by IAM policy.",
		"- The request was blocked by authentication.",
		"- Access to the log group was blocked by permission boundary.",
	];
	for (const line of ROUTINE) {
		test(`routine, does NOT count: ${line.slice(2, 50)}`, () => {
			expect(isDegradingGapBullet(line)).toBe(false);
		});
	}
	for (const line of DEGRADED) {
		test(`degraded, DOES count: ${line.slice(2, 50)}`, () => {
			expect(isDegradingGapBullet(line)).toBe(true);
		});
	}

	test("'not available' (tool missing) degrades but 'not applicable' (N/A) does not", () => {
		expect(isDegradingGapBullet("- ksql_get_server_info not available")).toBe(true);
		expect(isDegradingGapBullet("- API-gateway telemetry not applicable")).toBe(false);
	});
});

describe("countDegradingGapBullets (SIO-1106)", () => {
	test("counts 0 degrading in a Gaps section of only routine no-data bullets", () => {
		const report = `## Gaps
- Kafka: no consumer-group lag data was retrieved (service is not a Kafka consumer).
- Konnect: no Kong route matches; API-gateway telemetry not applicable.
- GitLab: no recent merge requests found in the last 7 days.
- Atlassian: no linked Jira incident ticket was found.

Confidence: 0.72`;
		expect(extractGapsBulletCount(report)).toBe(4); // total unchanged
		expect(countDegradingGapBullets(report)).toBe(0); // none degrade
	});

	test("counts all degrading bullets (styles-v3 shape)", () => {
		const report = `## Gaps
- live APM cardinality could not be re-run
- ksql_get_server_info not available
- Atlassian parse failures

Confidence: 0.71`;
		expect(countDegradingGapBullets(report)).toBe(3);
	});

	test("counts only the degrading subset in a mixed section", () => {
		const report = `## Gaps
- Kafka: no consumer-group lag data was retrieved (not a Kafka consumer).
- CloudWatch Logs query timed out and could not complete.
- Konnect: no Kong route matches; not applicable.
- Elasticsearch SQL query failed with an index error.

Confidence: 0.7`;
		expect(extractGapsBulletCount(report)).toBe(4);
		expect(countDegradingGapBullets(report)).toBe(2);
	});
});

// SIO-709 AC #2: Gaps-section parser must trigger the same 0.59 cap when the
// LLM lists >= 2 gap bullets, regardless of tool-error rate. The styles-v3
// transcript had 5 gap bullets and was the original failure mode.
// SIO-1106: the cap now triggers on DEGRADING gap bullets only; routine no-data gaps do not cap.
describe.skipIf(!hasRunbooks)("aggregate SIO-709 Gaps-section confidence cap", () => {
	beforeEach(() => {
		_setAggregatorLoggerForTesting(makeAggregatorCaptureLogger([]));
		lastInvokeMessages = null;
	});

	afterEach(() => {
		_setAggregatorLoggerForTesting(null);
		mockLlmContent = "Mock aggregator output. Confidence: 0.5";
	});

	test("caps confidence at 0.59 when finalAnswer has Gaps section with >= 2 bullets", async () => {
		mockLlmContent = `# Incident report\n\n## Findings\n- something\n\n## Gaps\n- live APM cardinality could not be re-run\n- 7.5x duplication ratio is from pre-timeout analysis\n- ksql_get_server_info not available\n\nConfidence: 0.71`;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidenceCap).toBe(0.59);
		// SIO-860: prose confidence rewritten to the capped value (was 0.71).
		expect(result.finalAnswer).toContain("Confidence: 0.59");
		expect(result.finalAnswer).not.toContain("Confidence: 0.71");
	});

	test("does NOT cap when Gaps section has only 1 bullet", async () => {
		mockLlmContent = `# Report\n\n## Gaps\n- one minor item\n\nConfidence: 0.9`;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.9);
		expect(result.confidenceCap).toBeUndefined();
		// SIO-860: no cap triggered, so the LLM's printed confidence is left untouched.
		expect(result.finalAnswer).toContain("Confidence: 0.9");
	});

	test("does NOT cap when no Gaps section exists", async () => {
		mockLlmContent = `# Report\n\n## Findings\n- a\n\nConfidence: 0.9`;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.9);
		expect(result.confidenceCap).toBeUndefined();
	});

	// SIO-1106: a strong report (0.72) that honestly enumerates one ROUTINE gap per datasource
	// across a 6-source fan-out must clear the 0.6 HITL gate -- routine "found nothing / not
	// applicable / not queried" bullets are normal discovery outcomes, not coverage failures.
	// Before SIO-1106 this capped to 0.59 (6 total bullets >= 2). After, degrading count is 0.
	test("does NOT cap a strong report whose Gaps are all routine no-data items (SIO-1106)", async () => {
		mockLlmContent = `# Incident Report: prana-order-service AFS errors

## Summary
Root cause: seasons.dates secondary index query returns empty for the current FMS window.

## Findings
- elastic: 91 APM error docs for "AFS not found for FMS".
- couchbase: seasons.dates secondary GSI returned 0 rows for the requested FMS key.

## Gaps
- Kafka: no consumer-group lag data was retrieved (service is not a Kafka consumer).
- Konnect: no Kong route matches prana-order-service; API-gateway telemetry not applicable.
- GitLab: no recent merge requests found touching the seasons pipeline in the last 7 days.
- Atlassian: no linked Jira incident ticket was found for this service.
- AWS: CloudWatch metrics for the ingestion Lambda were not retrieved (out of estate scope).
- Elastic: synthetic-monitor results were not queried this turn.

Confidence: 0.72`;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.72);
		expect(result.confidenceCap).toBeUndefined();
		expect(result.finalAnswer).toContain("Confidence: 0.72");
	});

	// SIO-1106: the SAME report still caps if the Gaps section contains >= 2 DEGRADING bullets
	// (tool/query failures), proving the tuning narrows the trigger rather than disabling it.
	test("STILL caps when Gaps contain >= 2 degrading (failure) items (SIO-1106)", async () => {
		mockLlmContent = `# Incident Report

## Findings
- elastic: strong evidence.

## Gaps
- CloudWatch Logs query timed out after 30s and could not complete.
- Three Elasticsearch SQL queries failed with index errors.
- Konnect: no Kong route matches; not applicable.

Confidence: 0.85`;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidenceCap).toBe(0.59);
	});
});

// SIO-860: the printed confidence and the gate's confidenceScore must derive from
// one value. rewriteConfidenceInAnswer rewrites the dedicated confidence line to the
// capped score so the report prose never contradicts the low_confidence banner.
describe("rewriteConfidenceInAnswer (SIO-860)", () => {
	test("rewrites a strict Confidence line to the capped score", () => {
		const answer = "# Report\n\n## Findings\n- a\n\nConfidence: 0.9";
		expect(rewriteConfidenceInAnswer(answer, 0.59)).toBe("# Report\n\n## Findings\n- a\n\nConfidence: 0.59");
	});

	test("rewrites a bold/markdown Confidence line and preserves surrounding markup", () => {
		const answer = "**Confidence:** 0.92\n";
		expect(rewriteConfidenceInAnswer(answer, 0.59)).toBe("**Confidence:** 0.59\n");
	});

	test("rewrites a 'Confidence Score:' variant", () => {
		const answer = "Confidence Score: 0.88";
		expect(rewriteConfidenceInAnswer(answer, 0.59)).toBe("Confidence Score: 0.59");
	});

	test("rewrites only the confidence line, not coincidental numbers in prose", () => {
		const answer = "We are confident the 0.9 ratio is fine.\n\nConfidence: 0.9";
		expect(rewriteConfidenceInAnswer(answer, 0.59)).toBe("We are confident the 0.9 ratio is fine.\n\nConfidence: 0.59");
	});

	test("leaves the answer unchanged when no confidence line is present", () => {
		const answer = "# Report\n\n## Findings\n- a";
		expect(rewriteConfidenceInAnswer(answer, 0.59)).toBe(answer);
	});
});

// SIO-1133: the Request-Id footer is stamped DETERMINISTICALLY (== state.requestId), so a
// report pasted into a Jira ticket carries the machine key the learn-from lane scans for.
describe("appendRequestIdFooter (SIO-1133)", () => {
	const REQ = "1f5b2c8a-0d3e-4a9b-8c7d-2e6f4a1b9c0d";

	test("appends the footer with the exact requestId at the bottom", () => {
		const out = appendRequestIdFooter("# Report\n\nConfidence: 0.9", REQ);
		expect(out).toBe(`# Report\n\nConfidence: 0.9\n\n**Request-Id:** ${REQ}`);
		expect(out.endsWith(REQ)).toBe(true);
	});

	test("is idempotent -- a re-render does not stamp a second footer", () => {
		const once = appendRequestIdFooter("body", REQ);
		expect(appendRequestIdFooter(once, REQ)).toBe(once);
		expect(once.match(/\*\*Request-Id:\*\*/g)).toHaveLength(1);
	});

	// CodeRabbit PR #405: the idempotency check is footer-line-specific, so a report that
	// MENTIONS the id in its body still gets the required bottom footer.
	test("appends the footer even when the id appears in the body", () => {
		const body = `# Report\n\nThe Request-Id ${REQ} was referenced in a comment.`;
		const out = appendRequestIdFooter(body, REQ);
		expect(out.endsWith(`**Request-Id:** ${REQ}`)).toBe(true);
		// The body mention is not a `**Request-Id:**` footer line, so exactly one footer.
		expect(out.match(/\*\*Request-Id:\*\*/g)).toHaveLength(1);
	});

	test("trims trailing whitespace before appending so the footer sits flush", () => {
		expect(appendRequestIdFooter("body\n\n   \n", REQ)).toBe(`body\n\n**Request-Id:** ${REQ}`);
	});

	test("no-ops on an empty requestId (never stamps a blank footer)", () => {
		expect(appendRequestIdFooter("body", "")).toBe("body");
	});
});

function getUserPromptText(): string {
	if (!lastInvokeMessages || lastInvokeMessages.length === 0) return "";
	const humanMsgs = lastInvokeMessages.filter((m) => m._getType() === "human");
	return humanMsgs.map((m) => String(m.content)).join("\n");
}

// SIO-1133: the full aggregate() stamps the Request-Id footer into the emitted report,
// deterministically equal to state.requestId (not an LLM-rendered value).
describe.skipIf(!hasRunbooks)("aggregate SIO-1133 Request-Id footer", () => {
	beforeEach(() => {
		_setAggregatorLoggerForTesting(makeAggregatorCaptureLogger([]));
		lastInvokeMessages = null;
	});
	afterEach(() => {
		_setAggregatorLoggerForTesting(null);
	});

	// CodeRabbit PR #405: use a canonical UUID so the footer round-trips through the learn
	// matcher's extractRequestIds -- a non-UUID fixture could pass here while the real
	// incident-matching path ignores the stamped value.
	const REQ_ID = "1f5b2c8a-0d3e-4a9b-8c7d-2e6f4a1b9c0d";

	test("stamps **Request-Id:** <state.requestId> as the report footer", async () => {
		mockLlmContent = "Mock aggregator output. Confidence: 0.5";
		const result = await aggregate(makeState({ requestId: REQ_ID }));
		expect(result.finalAnswer).toContain(`**Request-Id:** ${REQ_ID}`);
		// Deterministic: the footer equals the state value, and the emitted AIMessage
		// carries the same text as the returned finalAnswer.
		expect(result.finalAnswer?.trimEnd().endsWith(REQ_ID)).toBe(true);
		expect(String(result.messages?.[0]?.content ?? "")).toContain(`**Request-Id:** ${REQ_ID}`);
		// The stamped footer is extractable by the learn matcher (the whole point).
		const { extractRequestIds } = await import("./learn/match.ts");
		expect(extractRequestIds(result.finalAnswer ?? "")).toEqual([REQ_ID]);
	});
});

// SIO-711: aggregator must not emit defensive phrases like "not fabricated"
// or "I am not hallucinating". The styles-v3 transcript volunteered this kind
// of reassurance; the prompt now forbids it explicitly and requires structured
// "[partial: <field>]" markers instead.
describe.skipIf(!hasRunbooks)("aggregate SIO-711 self-defensive prose forbidden", () => {
	beforeEach(() => {
		_setAggregatorLoggerForTesting(makeAggregatorCaptureLogger([]));
		lastInvokeMessages = null;
	});

	afterEach(() => {
		_setAggregatorLoggerForTesting(null);
		mockLlmContent = "Mock aggregator output. Confidence: 0.5";
	});

	test("aggregator user prompt contains the DEFENSIVE PROSE FORBIDDEN rule with all banned phrases", async () => {
		await aggregate(makeState({}));
		const prompt = getUserPromptText();
		expect(prompt).toContain("DEFENSIVE PROSE FORBIDDEN");
		expect(prompt).toContain("[partial:");
		// SIO-711: lock in the four phrases the styles-v3 regression motivated.
		// The original aggregator volunteered "not fabricated" -- a future prompt
		// edit that drops this phrase from the forbidden list would re-open the bug.
		expect(prompt).toContain('"not fabricated"');
		expect(prompt).toContain('"I am not hallucinating"');
		expect(prompt).toContain('"this is reliable"');
		expect(prompt).toContain('"based on real data"');
	});

	test("aggregator user prompt instructs the LLM to use a plain '## Gaps' heading", async () => {
		await aggregate(makeState({}));
		const prompt = getUserPromptText();
		// The Gaps parser in extractGapsBulletCount only matches plain '## Gaps' style
		// headings; bolded or compound headings (e.g. '## **Gaps**', '## Gaps and Limitations')
		// would silently bypass the cap. The prompt rule must steer the LLM toward the
		// matching form.
		expect(prompt).toContain("## Gaps");
	});
});

// SIO-750: continuation guidance replaces the older "Focus on answering the
// current query. Reference prior findings where relevant but do not repeat the
// full prior report." string whenever a priorAnswer AND an investigationFocus
// are both present. The old phrasing is what let the LLM frame turn 2 as
// "supersedes the prior analysis" and pivot to unrelated clusters.
describe.skipIf(!hasRunbooks)("aggregate SIO-750 continuation-aware prompt", () => {
	beforeEach(() => {
		_setAggregatorLoggerForTesting(makeAggregatorCaptureLogger([]));
		lastInvokeMessages = null;
	});

	afterEach(() => {
		_setAggregatorLoggerForTesting(null);
		mockLlmContent = "Mock aggregator output. Confidence: 0.7";
	});

	test("with priorAnswer + investigationFocus, prompt anchors to focus and forbids 'supersedes' framing", async () => {
		await aggregate(
			makeState({
				isFollowUp: true,
				finalAnswer: "## Previous incident report\n\nThe styles-v3 service was over-fetching...",
				investigationFocus: {
					services: ["pvh-services-styles-v3"],
					datasources: ["elastic", "kafka", "couchbase"],
					timeWindow: { from: "2026-05-14T17:00:00Z", to: "2026-05-14T18:00:00Z" },
					summary: "high investigation of pvh-services-styles-v3 -- styles-v3 over-fetch",
					establishedAtTurn: 1,
				},
			}),
		);
		const prompt = getUserPromptText();
		expect(prompt).toContain("CONTINUING");
		expect(prompt).toContain("pvh-services-styles-v3");
		expect(prompt).toContain("styles-v3 over-fetch");
		expect(prompt).toContain('do NOT start a fresh report or claim it "supersedes" the prior one');
		expect(prompt).toContain("focused question");
		// The older free-wander phrasing must not appear when a focus is set.
		expect(prompt).not.toContain("do not repeat the full prior report");
	});

	test("with priorAnswer but no investigationFocus, falls back to legacy guidance", async () => {
		await aggregate(
			makeState({
				isFollowUp: true,
				finalAnswer: "## Previous incident report\n\nSome prior analysis...",
				investigationFocus: undefined,
			}),
		);
		const prompt = getUserPromptText();
		// Legacy phrasing stays as a safety net for the (rare) cold-restart case
		// where the checkpointer lost the focus but the message history still
		// carries the prior answer.
		expect(prompt).toContain("do not repeat the full prior report");
		expect(prompt).not.toContain("CONTINUING");
	});

	test("with no priorAnswer, neither variant appears (clean first-turn prompt)", async () => {
		await aggregate(makeState({ isFollowUp: false, finalAnswer: "" }));
		const prompt = getUserPromptText();
		expect(prompt).not.toContain("CONTINUING");
		expect(prompt).not.toContain("do not repeat the full prior report");
	});
});

// SIO-833: per-result byte budget that bounds the aggregate prompt under estate fan-out.
describe("aggregateResultBudget (SIO-833)", () => {
	test("uses the per-result cap when there are few results", () => {
		expect(aggregateResultBudget(1, {})).toBe(32_768);
	});

	test("fair-shares the total budget across many results", () => {
		// floor(262144 / 10) = 26214, which is below the 32768 per-result cap.
		expect(aggregateResultBudget(10, {})).toBe(26_214);
	});

	test("never drops below the floor even with very many results", () => {
		expect(aggregateResultBudget(1000, {})).toBe(4_096);
	});

	test("explicit AGGREGATE_RESULT_CAP_BYTES=0 disables capping", () => {
		expect(aggregateResultBudget(5, { AGGREGATE_RESULT_CAP_BYTES: "0" })).toBeNull();
	});

	test("respects an explicit per-result override", () => {
		expect(aggregateResultBudget(1, { AGGREGATE_RESULT_CAP_BYTES: "8192" })).toBe(8_192);
	});
});

describe.skipIf(!hasRunbooks)("aggregate per-result data cap (SIO-833)", () => {
	test("truncates an oversized result's data before it enters the prompt", async () => {
		lastInvokeMessages = null;
		const huge = "x".repeat(100_000);
		await aggregate(
			makeState({
				targetDataSources: ["aws"],
				dataSourceResults: [
					{
						dataSourceId: "aws",
						deploymentId: "estate:prod",
						status: "success",
						data: huge,
						duration: 10,
						toolErrors: [],
					},
				],
			}),
		);
		const prompt = getUserPromptText();
		expect(prompt).toContain("[truncated,");
		expect(prompt.length).toBeLessThan(60_000); // far below the original 100KB
	});

	test("leaves a small result's data unchanged", async () => {
		lastInvokeMessages = null;
		await aggregate(
			makeState({
				dataSourceResults: [
					{ dataSourceId: "elastic", status: "success", data: "small result body", duration: 10, toolErrors: [] },
				],
			}),
		);
		expect(getUserPromptText()).toContain("small result body");
	});
});

// SIO-1018: load the real agent via gitagent-bridge (not mock.module-stubbable
// prompt-context.ts) so sibling test files that stub getAgent() to return
// { manifest: {} } cannot make this test return [].
const realAgentForSkills = (() => {
	try {
		return loadAgent(getAgentsDir());
	} catch {
		return null;
	}
})();

describe.skipIf(!realAgentForSkills)("getActiveSkillNames (SIO-1018)", () => {
	test("returns the manifest's active local skill names", () => {
		// Assert against realAgent.skills directly — pollution-proof because siblings
		// mock ./prompt-context.ts, not @devops-agent/gitagent-bridge.
		const realNames = [...(realAgentForSkills?.skills.keys() ?? [])];
		// agents/incident-analyzer/agent.yaml lists these under skills:
		expect(realNames).toContain("aggregate-findings");
		expect(realNames).toContain("normalize-incident");
		expect(realNames).toContain("propose-mitigation");
	});
});

describe.skipIf(!hasRunbooks)("aggregate: skillsApplied trace (SIO-1018)", () => {
	beforeEach(() => {
		_setAggregatorLoggerForTesting(makeAggregatorCaptureLogger([]));
		lastInvokeMessages = null;
	});

	afterEach(() => {
		_setAggregatorLoggerForTesting(null);
		mockLlmContent = "Mock aggregator output. Confidence: 0.5";
	});

	test("populates skillsApplied with the active skill names", async () => {
		const result = await aggregate(makeState({}));
		expect(result.skillsApplied).toContain("aggregate-findings");
	});

	test("populates skillsApplied even on the no-datasource-results path", async () => {
		const result = await aggregate(makeState({ dataSourceResults: [] }));
		expect(result.skillsApplied).toContain("aggregate-findings");
	});
});

// SIO-856: the aggregator must scope AWS claims to the estate(s) actually assessed
// (state.awsTargetEstates), not the full configured set that aws_list_estates returns.
describe.skipIf(!hasRunbooks)("aggregator: AWS estate scope guidance", () => {
	const awsResult = {
		dataSourceId: "aws",
		status: "success" as const,
		data: "estates: [7 configured, all STS OK]",
		duration: 100,
		deploymentId: "estate:eu-shared-services-prd",
		toolErrors: [],
	};

	test("single assessed estate -> prompt names it and forbids generalizing to other accounts", async () => {
		lastInvokeMessages = null;
		await aggregate(
			makeState({
				targetDataSources: ["aws"],
				awsTargetEstates: ["eu-shared-services-prd"],
				dataSourceResults: [awsResult],
			}),
		);
		const prompt = getUserPromptText();
		expect(prompt).toContain("AWS ESTATE SCOPE");
		expect(prompt).toContain("eu-shared-services-prd");
		// must instruct against the observed hallucination
		expect(prompt).toContain("Do NOT claim health, coverage, or status for any other AWS account");
		expect(prompt.toLowerCase()).toContain("aws_list_estates");
	});

	test("multiple assessed estates -> guidance lists all of them", async () => {
		lastInvokeMessages = null;
		await aggregate(
			makeState({
				targetDataSources: ["aws"],
				awsTargetEstates: ["eu-oit-prd", "eu-shared-services-prd"],
				dataSourceResults: [
					{ ...awsResult, deploymentId: "estate:eu-oit-prd" },
					{ ...awsResult, deploymentId: "estate:eu-shared-services-prd" },
				],
			}),
		);
		const prompt = getUserPromptText();
		expect(prompt).toContain("AWS ESTATE SCOPE");
		expect(prompt).toContain("eu-oit-prd");
		expect(prompt).toContain("eu-shared-services-prd");
	});

	test("no AWS estates -> no estate-scope guidance injected", async () => {
		lastInvokeMessages = null;
		await aggregate(
			makeState({
				targetDataSources: ["elastic"],
				awsTargetEstates: [],
				dataSourceResults: [
					{ dataSourceId: "elastic", status: "success", data: "elastic body", duration: 10, toolErrors: [] },
				],
			}),
		);
		expect(getUserPromptText()).not.toContain("AWS ESTATE SCOPE");
	});
});

// SIO-1149: regression corpus from the localcore-service run (requestId 9554e8d7). The
// pre-SIO-1149 classifier counted 6 of these 8 bullets as degrading (incident vocabulary
// like "ERROR-level", "(failed)", "failure pattern" plus a recovered timeout), capping an
// accurate 0.81 report to 0.59. Only the blast_radius bullet is a genuine unrecovered
// coverage failure.
const LOCALCORE_RUN_BULLETS: Array<[string, boolean]> = [
	[
		"- Stock-service did not log ERROR-level entries for the incident window; the internal cause of the HTTP 500 it returned is unconfirmed without WARN/DEBUG log access or X-Ray trace data.",
		false,
	],
	[
		"- The specific EAN list size sent by executor-thread-716 (failed) vs. threads 704 and 721 (succeeded) has not been retrieved; payload size as the discriminating factor is inferred, not confirmed.",
		false,
	],
	[
		"- gitlab_blast_radius was unavailable (Orbit knowledge graph schema violation on both invocations); cross-project impact of the filter removal on other consumers is unassessed.",
		true,
	],
	[
		"- kafka_list_dlq_topics timed out; DLQ analysis was completed via direct topic inspection but a full DLQ topic list was not retrieved.",
		false,
	],
	[
		"- bindplane-log-group in eu-shared-services-prd is not queryable with the current IAM role (confirmed authorization error on StartQuery); application logs routed via BindPlane are not accessible via CloudWatch Logs Insights.",
		false,
	],
	[
		"- localcore-service is not present in any ECS cluster in the eu-shared-services-prd estate; its deployment location within that estate is unconfirmed.",
		false,
	],
	[
		"- Couchbase Node 135 FFDC root cause is unknown; Couchbase support engagement is required to interpret the crash dumps.",
		false,
	],
	[
		"- No Jira incident ticket exists for this failure pattern; impact scope on downstream catalog data consumers has not been assessed.",
		false,
	],
];

describe("isDegradingGapBullet (SIO-1149 context gating + recovery exemption)", () => {
	for (const [line, want] of LOCALCORE_RUN_BULLETS) {
		test(`localcore corpus ${want ? "DOES" : "does NOT"} count: ${line.slice(2, 60)}`, () => {
			expect(isDegradingGapBullet(line)).toBe(want);
		});
	}

	test("recovery clause exempts a recovered tool failure", () => {
		expect(
			isDegradingGapBullet(
				"- kafka_list_dlq_topics timed out; DLQ analysis was completed via direct topic inspection.",
			),
		).toBe(false);
	});

	test("same failure without the recovery clause stays degrading", () => {
		expect(isDegradingGapBullet("- kafka_list_dlq_topics timed out; a full DLQ topic list was not retrieved.")).toBe(
			true,
		);
	});

	test("prompt's literal 'recovered via' phrase is honored by the classifier", () => {
		expect(isDegradingGapBullet("- kafka_list_dlq_topics timed out; recovered via kafka_describe_topic.")).toBe(false);
	});

	test("negation guard: 'could not be completed via' is not a recovery clause", () => {
		expect(isDegradingGapBullet("- Elastic: the export could not be completed via the API.")).toBe(true);
	});

	// CodeRabbit (PR #416): contraction and no-fallback negations must not read as recovery.
	test("negation guard: contractions and 'no fallback' are not recovery clauses", () => {
		expect(isDegradingGapBullet("- kafka_list_dlq_topics timed out; couldn't be recovered via replay.")).toBe(true);
		expect(
			isDegradingGapBullet("- kafka_list_dlq_topics timed out; no fallback to direct inspection was available."),
		).toBe(true);
		expect(isDegradingGapBullet("- The CloudWatch query timed out and was never recovered via re-anchoring.")).toBe(
			true,
		);
		expect(isDegradingGapBullet("- gitlab_blast_radius errored; the query never fell back to semantic search.")).toBe(
			true,
		);
	});

	test("weak arms (fail/error/exception) need tool or query context", () => {
		expect(isDegradingGapBullet("- The nightly sync job reported errors in its final run.")).toBe(false);
		expect(isDegradingGapBullet("- Three Elasticsearch SQL queries failed during investigation.")).toBe(true);
		expect(isDegradingGapBullet("- GitLab: pipeline lookups errored with HTTP 500.")).toBe(true);
	});

	test("SCREAMING_SNAKE data names are not tool context for the weak arms", () => {
		expect(isDegradingGapBullet("- 113k messages failed into DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS.")).toBe(false);
	});

	test("collectDegradingGapBullets returns the flagged bullet texts", () => {
		const report = `## Gaps\n${LOCALCORE_RUN_BULLETS.map(([l]) => l).join("\n")}\n\nConfidence: 0.81`;
		const flagged = collectDegradingGapBullets(report);
		expect(flagged).toHaveLength(1);
		expect(flagged[0]).toContain("gitlab_blast_radius");
		expect(countDegradingGapBullets(report)).toBe(1);
	});
});

// SIO-1149: the hybrid cap path. Regex flags candidates; at/above threshold a small-model
// judge may veto false positives; any judge failure is fail-closed (the cap applies).
describe.skipIf(!hasRunbooks)("aggregate SIO-1149 gaps judge veto", () => {
	const TWO_FLAGGED_GAPS = `# Incident Report

## Findings
- elastic: strong evidence.

## Gaps
- gitlab_blast_radius was unavailable (Orbit schema violation); cross-project impact is unassessed.
- kafka_list_dlq_topics timed out; a full DLQ topic list was not retrieved.

Confidence: 0.85`;

	beforeEach(() => {
		_setAggregatorLoggerForTesting(makeAggregatorCaptureLogger([]));
		lastInvokeMessages = null;
	});

	afterEach(() => {
		_setAggregatorLoggerForTesting(null);
		_setGapsJudgeLlmForTesting(null);
		mockLlmContent = "Mock aggregator output. Confidence: 0.5";
		delete process.env.GAPS_JUDGE_ENABLED;
	});

	test("localcore regression: the 8-bullet Gaps section no longer caps and the judge is not invoked", async () => {
		let judgeCalls = 0;
		_setGapsJudgeLlmForTesting({
			invoke: async () => {
				judgeCalls += 1;
				return { content: "" };
			},
		});
		mockLlmContent = `# Incident Report

## Findings
- aws: HTTP 500 from stock-service at 03:13:19 UTC.

## Gaps
${LOCALCORE_RUN_BULLETS.map(([l]) => l).join("\n")}

Confidence: 0.81`;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.81);
		expect(result.confidenceCap).toBeUndefined();
		expect(result.finalAnswer).toContain("Confidence: 0.81");
		// Regex count is 1 (< threshold 2), so the judge must never be consulted.
		expect(judgeCalls).toBe(0);
	});

	test("judge veto exempts a false positive: 2 flagged -> 1 confirmed -> no cap", async () => {
		_setGapsJudgeLlmForTesting({
			invoke: async () => ({
				content: JSON.stringify({
					verdicts: [
						{ index: 0, genuineUnrecoveredFailure: true, reason: "blast radius data genuinely missing" },
						{ index: 1, genuineUnrecoveredFailure: false, reason: "DLQ data recovered by direct inspection" },
					],
				}),
			}),
		});
		mockLlmContent = TWO_FLAGGED_GAPS;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.85);
		expect(result.confidenceCap).toBeUndefined();
	});

	test("judge confirming both bullets keeps the cap", async () => {
		_setGapsJudgeLlmForTesting({
			invoke: async () => ({
				content: JSON.stringify({
					verdicts: [
						{ index: 0, genuineUnrecoveredFailure: true, reason: "real" },
						{ index: 1, genuineUnrecoveredFailure: true, reason: "real" },
					],
				}),
			}),
		});
		mockLlmContent = TWO_FLAGGED_GAPS;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidenceCap).toBe(0.59);
	});

	test("judge failure is fail-closed: the regex verdict stands and the cap applies", async () => {
		_setGapsJudgeLlmForTesting({
			invoke: async () => {
				throw new Error("bedrock unavailable");
			},
		});
		mockLlmContent = TWO_FLAGGED_GAPS;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidenceCap).toBe(0.59);
	});

	test("malformed judge output (verdict count mismatch) is fail-closed", async () => {
		_setGapsJudgeLlmForTesting({
			invoke: async () => ({
				content: JSON.stringify({
					verdicts: [{ index: 0, genuineUnrecoveredFailure: false, reason: "only one verdict for two bullets" }],
				}),
			}),
		});
		mockLlmContent = TWO_FLAGGED_GAPS;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidenceCap).toBe(0.59);
	});

	test("GAPS_JUDGE_ENABLED=false skips the judge entirely", async () => {
		process.env.GAPS_JUDGE_ENABLED = "false";
		let judgeCalls = 0;
		_setGapsJudgeLlmForTesting({
			invoke: async () => {
				judgeCalls += 1;
				return { content: "" };
			},
		});
		mockLlmContent = TWO_FLAGGED_GAPS;
		const result = await aggregate(makeState({}));
		expect(judgeCalls).toBe(0);
		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidenceCap).toBe(0.59);
	});
});

// SIO-1149: prompt rules steering the LLM toward classifiable Gaps authoring and away
// from cross-estate absence bullets.
describe.skipIf(!hasRunbooks)("aggregator: SIO-1149 gaps authoring + cross-estate absence prompt rules", () => {
	const awsResult = {
		dataSourceId: "aws",
		status: "success" as const,
		data: "ecs services listed",
		duration: 100,
		deploymentId: "estate:eu-oit-prd",
		toolErrors: [],
	};

	afterEach(() => {
		mockLlmContent = "Mock aggregator output. Confidence: 0.5";
	});

	test("gaps authoring discipline is always injected, with the literal recovery phrase", async () => {
		lastInvokeMessages = null;
		await aggregate(makeState({}));
		const prompt = getUserPromptText();
		expect(prompt).toContain("GAPS AUTHORING DISCIPLINE");
		expect(prompt).toContain("recovered via");
	});

	test("multi-estate assessment injects the cross-estate absence rule", async () => {
		lastInvokeMessages = null;
		await aggregate(
			makeState({
				targetDataSources: ["aws"],
				awsTargetEstates: ["eu-oit-prd", "eu-shared-services-prd"],
				dataSourceResults: [awsResult, { ...awsResult, deploymentId: "estate:eu-shared-services-prd" }],
			}),
		);
		const prompt = getUserPromptText();
		expect(prompt).toContain("CROSS-ESTATE ABSENCE IS A FINDING");
		expect(prompt).toContain("not deployed in this estate");
		// CodeRabbit (PR #416): the claim requires complete successful enumeration.
		expect(prompt).toContain("enumeration completed successfully");
	});

	test("single-estate assessment omits the cross-estate absence rule", async () => {
		lastInvokeMessages = null;
		await aggregate(
			makeState({
				targetDataSources: ["aws"],
				awsTargetEstates: ["eu-oit-prd"],
				dataSourceResults: [awsResult],
			}),
		);
		expect(getUserPromptText()).not.toContain("CROSS-ESTATE ABSENCE IS A FINDING");
	});
});

// SIO-1155: aggregate() exposes cap metadata for the correlation recovery path.
describe.skipIf(!hasRunbooks)("aggregate SIO-1155 cap metadata", () => {
	afterEach(() => {
		mockLlmContent = "Mock aggregator output. Confidence: 0.5";
	});

	test("a gaps-capped run exposes capReasons, the pre-cap score, and confirmed bullets", async () => {
		mockLlmContent = `# Report

## Gaps
- CloudWatch Logs query timed out after 30s and could not complete.
- Three Elasticsearch SQL queries failed with index errors.

Confidence: 0.85`;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidencePreCap).toBe(0.85);
		expect(result.capReasons).toEqual(["gaps"]);
		expect(result.confirmedDegradingGapBullets?.length).toBe(2);
		expect(result.confirmedDegradingGapBullets?.[0]).toContain("timed out");
	});

	test("an uncapped run exposes empty cap metadata", async () => {
		mockLlmContent = "# Report\n\n## Findings\n- fine\n\nConfidence: 0.9";
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.9);
		expect(result.capReasons).toEqual([]);
		expect(result.confirmedDegradingGapBullets).toEqual([]);
		expect(result.confidencePreCap).toBe(0.9);
	});
});
