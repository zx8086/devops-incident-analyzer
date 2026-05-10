// packages/agent/src/aggregator.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentStateType } from "./state.ts";

// SIO-640, SIO-635: Network-boundary mocks only. We cannot mock
// @devops-agent/gitagent-bridge or ./prompt-context.ts without causing
// cross-file test pollution (see SIO-635). Instead, capture the messages
// handed to ChatBedrockConverse.invoke() and verify the system prompt
// reflects the expected runbook filter semantics. The real loaded agent
// at agents/incident-analyzer provides the runbooks.

let lastInvokeMessages: BaseMessage[] | null = null;

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
			return { content: "Mock aggregator output. Confidence: 0.5" };
		}
	},
}));

mock.module("@devops-agent/shared", () => ({
	redactPiiContent: (s: string) => s,
}));

import { _setAggregatorLoggerForTesting, aggregate } from "./aggregator.ts";
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
