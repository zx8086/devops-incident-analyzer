// packages/agent/src/alignment.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { _setAlignmentLoggerForTesting, routeAfterAlignment, summarizeFirstAttempts } from "./alignment.ts";
import type { AgentStateType } from "./state.ts";

describe("summarizeFirstAttempts", () => {
	test("flags first-failed retry-succeeded as recovered", () => {
		// Recursion-limit failures fall through classifyToolError's pattern set to "unknown" --
		// the alignment retry path treats unknown as retryable, so functionally it behaves the
		// same as transient. The category is preserved verbatim in the summary so an operator
		// reading the WARN can tell apart a recursion-limit failure from a 503 timeout.
		const results: DataSourceResult[] = [
			{
				dataSourceId: "elastic",
				data: null,
				status: "error",
				duration: 202609,
				isAlignmentRetry: false,
				error: "Recursion limit of 25 reached without hitting a stop condition.",
			},
			{
				dataSourceId: "elastic",
				data: "ok",
				status: "success",
				duration: 139900,
				isAlignmentRetry: true,
			},
		];
		const summary = summarizeFirstAttempts(results);
		expect(summary).toEqual([
			{
				dataSourceId: "elastic",
				firstStatus: "error",
				firstCategory: "unknown",
				firstDurationMs: 202609,
				recovered: true,
			},
		]);
	});

	test("classifies a real timeout/transient error as 'transient'", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "elastic",
				data: null,
				status: "error",
				duration: 60000,
				isAlignmentRetry: false,
				error: "ECONNRESET while talking to elasticsearch",
			},
			{
				dataSourceId: "elastic",
				data: "ok",
				status: "success",
				duration: 10000,
				isAlignmentRetry: true,
			},
		];
		const summary = summarizeFirstAttempts(results);
		expect(summary[0]?.firstCategory).toBe("transient");
		expect(summary[0]?.recovered).toBe(true);
	});

	test("clean first attempt has no recovered flag and no category", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "kafka",
				data: "ok",
				status: "success",
				duration: 4200,
				isAlignmentRetry: false,
			},
		];
		expect(summarizeFirstAttempts(results)).toEqual([
			{
				dataSourceId: "kafka",
				firstStatus: "success",
				firstDurationMs: 4200,
				recovered: false,
			},
		]);
	});

	test("first failure with no retry stays failed", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "konnect",
				data: null,
				status: "error",
				duration: 1234,
				isAlignmentRetry: false,
				error: "session not found",
			},
		];
		expect(summarizeFirstAttempts(results)).toEqual([
			{
				dataSourceId: "konnect",
				firstStatus: "error",
				firstCategory: "session",
				firstDurationMs: 1234,
				recovered: false,
			},
		]);
	});

	test("uses tool-error categories when present, falls back to top-level error classification", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "gitlab",
				data: null,
				status: "error",
				duration: 5000,
				isAlignmentRetry: false,
				error: "All 3 tool calls failed",
				toolErrors: [
					{ toolName: "gitlab_search", category: "auth", message: "401", retryable: false },
					{ toolName: "gitlab_diff", category: "transient", message: "timeout", retryable: true },
				],
			},
		];
		const summary = summarizeFirstAttempts(results);
		expect(summary[0]?.firstCategory).toBe("auth");
	});

	test("dedupes by dataSourceId taking the failing first-attempt result over a successful sibling", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "elastic",
				deploymentId: "eu-b2c",
				data: null,
				status: "error",
				duration: 100,
				isAlignmentRetry: false,
				error: "timeout",
			},
			{
				dataSourceId: "elastic",
				deploymentId: "eu-plm",
				data: "ok",
				status: "success",
				duration: 200,
				isAlignmentRetry: false,
			},
			{
				dataSourceId: "elastic",
				data: "ok",
				status: "success",
				duration: 150,
				isAlignmentRetry: true,
			},
		];
		const summary = summarizeFirstAttempts(results);
		expect(summary).toHaveLength(1);
		expect(summary[0]?.dataSourceId).toBe("elastic");
		expect(summary[0]?.firstStatus).toBe("error");
		expect(summary[0]?.recovered).toBe(true);
	});
});

interface CapturedLog {
	level: "info" | "warn" | "error";
	meta: Record<string, unknown> | undefined;
	msg: string;
}

function makeCaptureLogger(captured: CapturedLog[]): Parameters<typeof _setAlignmentLoggerForTesting>[0] {
	const record =
		(level: CapturedLog["level"]) =>
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

function makeRetryState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		queryComplexity: "complex",
		targetDataSources: ["elastic"],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults: [
			{
				dataSourceId: "elastic",
				data: null,
				status: "error",
				duration: 202609,
				isAlignmentRetry: false,
				error: "ECONNRESET while talking to elasticsearch",
			},
		],
		currentDataSource: "",
		extractedEntities: { dataSources: [] },
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous",
		toolPlan: [],
		validationResult: "pass",
		retryCount: 0,
		alignmentRetries: 1,
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

describe("routeAfterAlignment retry-dispatch logging", () => {
	afterEach(() => {
		_setAlignmentLoggerForTesting(null);
	});

	test("emits a WARN with per-source firstAttempts when retries fire", () => {
		const captured: CapturedLog[] = [];
		_setAlignmentLoggerForTesting(makeCaptureLogger(captured));

		const decision = routeAfterAlignment(makeRetryState());

		expect(Array.isArray(decision)).toBe(true);
		const dispatchWarn = captured.find((c) => c.level === "warn" && Array.isArray(c.meta?.firstAttempts));
		expect(dispatchWarn).toBeDefined();
		const meta = dispatchWarn?.meta as {
			firstAttempts: Array<{ dataSourceId: string; firstStatus: string; firstCategory?: string }>;
			retryTargets: string[];
			retryAttempt: number;
		};
		expect(meta.firstAttempts[0]).toMatchObject({
			dataSourceId: "elastic",
			firstStatus: "error",
			firstCategory: "transient",
		});
		expect(meta.retryTargets).toEqual(["elastic"]);
		expect(meta.retryAttempt).toBe(1);
	});

	test("does NOT emit the firstAttempts WARN when no retries fire (clean state)", () => {
		const captured: CapturedLog[] = [];
		_setAlignmentLoggerForTesting(makeCaptureLogger(captured));

		const cleanState = makeRetryState({
			dataSourceResults: [
				{
					dataSourceId: "elastic",
					data: "ok",
					status: "success",
					duration: 4200,
					isAlignmentRetry: false,
				},
			],
		});
		const decision = routeAfterAlignment(cleanState);

		expect(decision).toBe("aggregate");
		const dispatchWarn = captured.find((c) => c.level === "warn" && Array.isArray(c.meta?.firstAttempts));
		expect(dispatchWarn).toBeUndefined();
	});
});

// SIO-697: alignment retry must scope elastic re-runs to only the deployments
// that failed on the first attempt. Previously the retry re-ran every elastic
// deployment in targetDeployments, wasting budget on siblings that already
// succeeded.
describe("routeAfterAlignment retryDeployments selection", () => {
	test("only the failed elastic deployment is in retryDeployments", () => {
		const state = makeRetryState({
			targetDeployments: ["eu-b2b", "us-cld-monitor"],
			dataSourceResults: [
				{
					dataSourceId: "elastic",
					deploymentId: "eu-b2b",
					data: "ok",
					status: "success",
					duration: 150_000,
					isAlignmentRetry: false,
				},
				{
					dataSourceId: "elastic",
					deploymentId: "us-cld-monitor",
					data: null,
					status: "error",
					duration: 218_000,
					isAlignmentRetry: false,
					error: "Recursion limit reached",
				},
			],
		});

		const decision = routeAfterAlignment(state);
		expect(Array.isArray(decision)).toBe(true);
		const sends = decision as Array<{ args: Record<string, unknown> }>;
		expect(sends).toHaveLength(1);
		const payload = sends[0]?.args as { currentDataSource: string; retryDeployments: string[] };
		expect(payload.currentDataSource).toBe("elastic");
		expect(payload.retryDeployments).toEqual(["us-cld-monitor"]);
	});

	test("non-elastic retry payloads carry empty retryDeployments", () => {
		const state = makeRetryState({
			targetDataSources: ["kafka"],
			targetDeployments: [],
			dataSourceResults: [
				{
					dataSourceId: "kafka",
					data: null,
					status: "error",
					duration: 9000,
					isAlignmentRetry: false,
					error: "ECONNRESET",
				},
			],
		});

		const decision = routeAfterAlignment(state);
		const sends = decision as Array<{ args: Record<string, unknown> }>;
		expect(sends).toHaveLength(1);
		const payload = sends[0]?.args as { currentDataSource: string; retryDeployments: string[] };
		expect(payload.currentDataSource).toBe("kafka");
		expect(payload.retryDeployments).toEqual([]);
	});
});
