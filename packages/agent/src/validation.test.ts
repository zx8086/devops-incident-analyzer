// agent/src/validation.test.ts
// Validation tests -- everything that runs without LLM or MCP servers
import { describe, expect, mock, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

// Mock MCP bridge so supervisor tests don't depend on connected MCP servers.
const VALID_DATASOURCES = new Set(["elastic", "kafka", "couchbase", "konnect"]);
mock.module("./mcp-bridge.ts", () => ({
	getToolsForDataSource: (id: string) => (VALID_DATASOURCES.has(id) ? [{ name: `${id}_tool` }] : []),
	getAllTools: () => [],
	getConnectedServers: () => [...VALID_DATASOURCES],
}));

import { checkAlignment, routeAfterAlignment } from "./alignment.ts";
import { classify } from "./classifier.ts";
import { supervise } from "./supervisor.ts";
import { shouldRetryValidation, validate } from "./validator.ts";

// Helper to build minimal state for testing
function makeState(overrides: Record<string, unknown> = {}) {
	return {
		messages: [],
		queryComplexity: "complex" as const,
		targetDataSources: [] as string[],
		targetDeployments: [] as string[],
		retryDeployments: [] as string[],
		dataSourceResults: [] as DataSourceResult[],
		currentDataSource: "",
		extractedEntities: { dataSources: [] },
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous" as const,
		toolPlan: [],
		validationResult: "pass" as const,
		retryCount: 0,
		alignmentRetries: 0,
		alignmentHints: [] as string[],
		skippedDataSources: [] as string[],
		isFollowUp: false,
		finalAnswer: "",
		dataSourceContext: undefined,
		requestId: "test-123",
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		mitigationFragments: [],
		confidenceScore: 0,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		partialFailures: [],
		investigationFocus: undefined,
		pendingTopicShiftPrompt: undefined,
		...overrides,
	};
}

describe("classifier: regex fast-path", () => {
	test("classifies 'hello' as simple", async () => {
		const state = makeState({ messages: [new HumanMessage("hello")] });
		const result = await classify(state);
		expect(result.queryComplexity).toBe("simple");
	});

	test("classifies 'hi there' as simple", async () => {
		const state = makeState({ messages: [new HumanMessage("hi there")] });
		const result = await classify(state);
		expect(result.queryComplexity).toBe("simple");
	});

	test("classifies 'help' as simple", async () => {
		const state = makeState({ messages: [new HumanMessage("help")] });
		const result = await classify(state);
		expect(result.queryComplexity).toBe("simple");
	});

	test("classifies 'what can you do' as simple", async () => {
		const state = makeState({ messages: [new HumanMessage("what can you do")] });
		const result = await classify(state);
		expect(result.queryComplexity).toBe("simple");
	});

	test("classifies 'thanks' as simple", async () => {
		const state = makeState({ messages: [new HumanMessage("thanks")] });
		const result = await classify(state);
		expect(result.queryComplexity).toBe("simple");
	});

	// SIO-749: follow-up detection moved to the UI; classifier no longer fakes
	// it up from a regex. These tests now verify that the UI signal flows
	// through unchanged and that a first-turn complex query is classified
	// correctly without isFollowUp being clobbered.
	test("does not clobber inbound isFollowUp:true (UI signal flows through)", async () => {
		const state = makeState({
			messages: [new HumanMessage("is kafka still failing?")],
			isFollowUp: true,
		});
		const result = await classify(state);
		// classify() returns a partial state; isFollowUp is absent from the
		// return because the classifier doesn't touch it. The Annotation
		// reducer preserves the inbound value, so downstream nodes see true.
		expect(result.isFollowUp).toBeUndefined();
		expect(result.queryComplexity).toBe("complex");
	});

	test("first-turn complex query leaves isFollowUp at default false", async () => {
		const state = makeState({
			messages: [new HumanMessage("check elasticsearch error logs for the past hour")],
		});
		const result = await classify(state);
		expect(result.isFollowUp).toBeUndefined();
		expect(result.queryComplexity).toBe("complex");
	});

	test("returns simple for empty messages", async () => {
		const state = makeState({ messages: [] });
		const result = await classify(state);
		expect(result.queryComplexity).toBe("simple");
	});

	test("returns simple for non-human last message", async () => {
		const state = makeState({ messages: [new AIMessage("I am the assistant")] });
		const result = await classify(state);
		expect(result.queryComplexity).toBe("simple");
	});
});

describe("supervisor: datasource routing", () => {
	test("routes to all 4 datasources when none specified", () => {
		const state = makeState();
		const sends = supervise(state);
		expect(sends).toHaveLength(4);
		const dsIds = sends.map((s) => s.args?.currentDataSource);
		expect(dsIds).toContain("elastic");
		expect(dsIds).toContain("kafka");
		expect(dsIds).toContain("couchbase");
		expect(dsIds).toContain("konnect");
	});

	test("routes to UI-selected datasources only", () => {
		const state = makeState({ targetDataSources: ["elastic", "kafka"] });
		const sends = supervise(state);
		expect(sends).toHaveLength(2);
	});

	test("routes to extracted entity datasources", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [
					{ id: "couchbase", mentionedAs: "database" },
					{ id: "konnect", mentionedAs: "api gateway" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(2);
	});

	test("deduplicates datasource IDs", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "logs" },
					{ id: "elastic", mentionedAs: "elasticsearch" },
					{ id: "elastic", mentionedAs: "ELK" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(1);
	});

	test("ignores invalid datasource IDs", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "logs" },
					{ id: "nonexistent", mentionedAs: "???" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(1);
	});

	test("each Send includes currentDataSource in args", () => {
		const state = makeState({ targetDataSources: ["kafka"] });
		const sends = supervise(state);
		expect(sends[0]?.args?.currentDataSource).toBe("kafka");
	});
});

describe("alignment: cross-datasource gap detection", () => {
	test("no retry when all datasources returned successfully", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka", "couchbase"],
			dataSourceResults: [
				{ dataSourceId: "elastic", data: "logs", status: "success" },
				{ dataSourceId: "kafka", data: "events", status: "success" },
				{ dataSourceId: "couchbase", data: "health", status: "success" },
			],
		});
		expect(routeAfterAlignment(state)).toBe("aggregate");
	});

	test("retries when a datasource is missing", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka", "couchbase"],
			dataSourceResults: [
				{ dataSourceId: "elastic", data: "logs", status: "success" },
				{ dataSourceId: "kafka", data: "events", status: "success" },
			],
		});
		const result = routeAfterAlignment(state);
		expect(Array.isArray(result)).toBe(true);
	});

	test("retries when a datasource returned an error", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [
				{ dataSourceId: "elastic", data: "logs", status: "success" },
				{ dataSourceId: "kafka", data: null, status: "error", error: "connection refused" },
			],
		});
		const result = routeAfterAlignment(state);
		expect(Array.isArray(result)).toBe(true);
	});

	test("stops retrying after 2 alignment attempts", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [{ dataSourceId: "elastic", data: "logs", status: "success" }],
			alignmentRetries: 2,
		});
		const result = checkAlignment(state);
		expect(result.alignmentHints).toBeDefined();
		expect(result.alignmentHints?.length).toBeGreaterThan(0);
		expect(routeAfterAlignment(state)).toBe("aggregate");
	});

	test("routes to retries for missing datasource", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [{ dataSourceId: "elastic", data: "logs", status: "success" }],
			alignmentRetries: 0,
		});
		const result = routeAfterAlignment(state);
		expect(Array.isArray(result)).toBe(true);
	});
});

describe("validator: anti-hallucination checks", () => {
	test("passes a well-formed answer referencing all datasources", () => {
		const state = makeState({
			finalAnswer:
				"Analysis shows the elastic cluster has elevated error rates since 14:30 UTC. The kafka consumer group payments-processor has 50,000 messages of lag. The couchbase cluster shows increased query latency. The konnect API gateway reports 5xx errors on the payments route.",
			dataSourceResults: [
				{ dataSourceId: "elastic", data: "error logs found", status: "success" },
				{ dataSourceId: "kafka", data: "lag detected", status: "success" },
				{ dataSourceId: "couchbase", data: "slow queries", status: "success" },
				{ dataSourceId: "konnect", data: "5xx errors", status: "success" },
			],
		});
		const result = validate(state);
		expect(result.validationResult).toBe("pass");
	});

	test("fails an empty answer", () => {
		const state = makeState({ finalAnswer: "" });
		const result = validate(state);
		expect(result.validationResult).toBe("fail");
		expect(result.retryCount).toBe(1);
	});

	test("fails a too-short answer (< 50 chars)", () => {
		const state = makeState({ finalAnswer: "Everything looks fine." });
		const result = validate(state);
		expect(result.validationResult).toBe("fail");
	});

	test("warns when a datasource result is not referenced", () => {
		const state = makeState({
			finalAnswer:
				"The elastic cluster shows errors. The kafka consumers are lagging. Analysis complete with high confidence.",
			dataSourceResults: [
				{ dataSourceId: "elastic", data: "errors", status: "success" },
				{ dataSourceId: "kafka", data: "lag", status: "success" },
				{ dataSourceId: "couchbase", data: "slow queries", status: "success" },
			],
		});
		const result = validate(state);
		// couchbase was queried but not mentioned in answer
		expect(result.validationResult).toBe("pass_with_warnings");
	});

	test("shouldRetryValidation returns true for fail with retryCount < 2", () => {
		expect(shouldRetryValidation(makeState({ validationResult: "fail", retryCount: 0 }))).toBe(true);
		expect(shouldRetryValidation(makeState({ validationResult: "fail", retryCount: 1 }))).toBe(true);
	});

	test("shouldRetryValidation returns false when retryCount >= 2", () => {
		expect(shouldRetryValidation(makeState({ validationResult: "fail", retryCount: 2 }))).toBe(false);
		expect(shouldRetryValidation(makeState({ validationResult: "fail", retryCount: 5 }))).toBe(false);
	});

	test("shouldRetryValidation returns false for pass", () => {
		expect(shouldRetryValidation(makeState({ validationResult: "pass", retryCount: 0 }))).toBe(false);
	});

	test("shouldRetryValidation returns false for pass_with_warnings", () => {
		expect(shouldRetryValidation(makeState({ validationResult: "pass_with_warnings", retryCount: 0 }))).toBe(false);
	});

	// SIO-768: regression — the AWS SDK returns EC2 StateTransitionReason as
	// "User initiated (2025-10-18 21:13:00 GMT)". The aggregator normalizes this
	// to ISO-8601 in the final answer. Pre-fix, the validator's T-only regex
	// missed the AWS-format string in the source data and flagged the answer
	// as fabricated even though the timestamp originated from a real tool output.
	test("AWS-format timestamps in source data match ISO-format timestamps in answer", () => {
		const state = makeState({
			finalAnswer:
				"Analysis of the aws account shows instance i-abc has been stopped since 2025-10-18T21:13:00Z. The security group rule remains permissive on TCP/22.",
			dataSourceResults: [
				{
					dataSourceId: "aws",
					data: "EC2 instance i-abc stopped. StateTransitionReason: User initiated (2025-10-18 21:13:00 GMT). SG sg-xyz allows 0.0.0.0/0:22.",
					status: "success" as const,
				},
			],
		});
		const result = validate(state);
		expect(result.validationResult).toBe("pass");
	});

	// SIO-768: AWS SDK's Date fields serialize to ISO with millis ("2026-05-15T22:48:00.000Z").
	// The aggregator typically drops the millis. The normalization step must collapse
	// these two forms to the same key so the answer is not flagged.
	test("ISO-with-millis source matches ISO-without-millis answer", () => {
		const state = makeState({
			finalAnswer: "The aws EC2 instance was launched at 2026-05-15T22:48:00Z. No alarms have fired since startup.",
			dataSourceResults: [
				{
					dataSourceId: "aws",
					data: "EC2 instance i-def LaunchTime: 2026-05-15T22:48:00.000Z, state: running.",
					status: "success" as const,
				},
			],
		});
		const result = validate(state);
		expect(result.validationResult).toBe("pass");
	});

	// SIO-768: ensure the widened regex still catches genuine fabrications.
	// A timestamp that cannot be normalized to anything present in source data
	// (and is outside the 5-minute "now" window) must still trigger a warning.
	test("genuinely fabricated timestamp (not in any source format) still flags", () => {
		const state = makeState({
			finalAnswer:
				"The aws EC2 instance i-ghi is currently running and has no recorded events. There was an incident at 2020-01-01T00:00:00Z but no record exists.",
			dataSourceResults: [
				{
					dataSourceId: "aws",
					data: "EC2 instance i-ghi LaunchTime: 2026-05-10T10:00:00.000Z, state: running.",
					status: "success" as const,
				},
			],
		});
		const result = validate(state);
		expect(result.validationResult).toBe("pass_with_warnings");
	});
});

describe("graph: compilation smoke test", () => {
	test("buildGraph compiles without errors", async () => {
		// This tests that all nodes are wired correctly
		const { buildGraph } = await import("./graph.ts");
		const graph = await buildGraph({ checkpointerType: "memory" });
		expect(graph).toBeDefined();
		expect(typeof graph.invoke).toBe("function");
		expect(typeof graph.stream).toBe("function");
	});
});

describe("tool-retry: exponential backoff", () => {
	test("returns result on first success", async () => {
		const { withRetry } = await import("./tool-retry.ts");
		const result = await withRetry(() => Promise.resolve("ok"), { maxRetries: 3 });
		expect(result).toBe("ok");
	});

	test("retries and succeeds on second attempt", async () => {
		const { withRetry } = await import("./tool-retry.ts");
		let attempt = 0;
		const result = await withRetry(
			() => {
				attempt++;
				if (attempt === 1) throw new Error("first fail");
				return Promise.resolve("ok");
			},
			{ maxRetries: 3, baseDelayMs: 1 },
		);
		expect(result).toBe("ok");
		expect(attempt).toBe(2);
	});

	test("throws after max retries exhausted", async () => {
		const { withRetry } = await import("./tool-retry.ts");
		await expect(
			withRetry(() => Promise.reject(new Error("always fails")), { maxRetries: 2, baseDelayMs: 1 }),
		).rejects.toThrow("always fails");
	});
});
