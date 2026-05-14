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
}));

import { _setAggregatorLoggerForTesting, aggregate, extractGapsBulletCount } from "./aggregator.ts";
import { getRunbookFilenames } from "./prompt-context.ts";

function getSystemPromptText(): string {
	if (!lastInvokeMessages || lastInvokeMessages.length === 0) return "";
	const systemMsg = lastInvokeMessages.find((m) => m._getType() === "system");
	if (!systemMsg) return "";
	return String(systemMsg.content);
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
		dataSourceContext: undefined,
		requestId: "test",
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		investigationFocus: undefined,
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

// SIO-709 AC #2: Gaps-section parser must trigger the same 0.59 cap when the
// LLM lists >= 2 gap bullets, regardless of tool-error rate. The styles-v3
// transcript had 5 gap bullets and was the original failure mode.
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
	});

	test("does NOT cap when Gaps section has only 1 bullet", async () => {
		mockLlmContent = `# Report\n\n## Gaps\n- one minor item\n\nConfidence: 0.9`;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.9);
		expect(result.confidenceCap).toBeUndefined();
	});

	test("does NOT cap when no Gaps section exists", async () => {
		mockLlmContent = `# Report\n\n## Findings\n- a\n\nConfidence: 0.9`;
		const result = await aggregate(makeState({}));
		expect(result.confidenceScore).toBe(0.9);
		expect(result.confidenceCap).toBeUndefined();
	});
});

function getUserPromptText(): string {
	if (!lastInvokeMessages || lastInvokeMessages.length === 0) return "";
	const humanMsgs = lastInvokeMessages.filter((m) => m._getType() === "human");
	return humanMsgs.map((m) => String(m.content)).join("\n");
}

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
