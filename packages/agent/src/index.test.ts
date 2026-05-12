// agent/src/index.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";

// Mock MCP bridge so supervisor tests don't depend on connected MCP servers.
// Returns a single fake tool for any valid datasource ID.
const VALID_DATASOURCES = new Set(["elastic", "kafka", "couchbase", "konnect"]);
mock.module("./mcp-bridge.ts", () => ({
	getToolsForDataSource: (id: string) => (VALID_DATASOURCES.has(id) ? [{ name: `${id}_tool` }] : []),
	getAllTools: () => [],
	getConnectedServers: () => [...VALID_DATASOURCES],
}));

import { checkAlignment, routeAfterAlignment } from "./alignment.ts";
import { AgentState } from "./state.ts";
import { supervise } from "./supervisor.ts";
import { shouldRetryValidation, validate } from "./validator.ts";

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
		...overrides,
	};
}

describe("AgentState", () => {
	test("state annotation has expected fields", () => {
		expect(AgentState.spec).toBeDefined();
		expect(AgentState.spec.queryComplexity).toBeDefined();
		expect(AgentState.spec.targetDataSources).toBeDefined();
		expect(AgentState.spec.dataSourceResults).toBeDefined();
		expect(AgentState.spec.currentDataSource).toBeDefined();
		expect(AgentState.spec.extractedEntities).toBeDefined();
		expect(AgentState.spec.previousEntities).toBeDefined();
		expect(AgentState.spec.toolPlanMode).toBeDefined();
		expect(AgentState.spec.validationResult).toBeDefined();
		expect(AgentState.spec.retryCount).toBeDefined();
		expect(AgentState.spec.alignmentRetries).toBeDefined();
		expect(AgentState.spec.isFollowUp).toBeDefined();
		expect(AgentState.spec.finalAnswer).toBeDefined();
		expect(AgentState.spec.requestId).toBeDefined();
		expect(AgentState.spec.suggestions).toBeDefined();
	});
});

describe("alignment", () => {
	test("passes when all targeted datasources have results", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [
				{ dataSourceId: "elastic", data: "ok", status: "success" },
				{ dataSourceId: "kafka", data: "ok", status: "success" },
			],
		});
		expect(routeAfterAlignment(state)).toBe("aggregate");
	});

	test("retries when datasource is missing", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [{ dataSourceId: "elastic", data: "ok", status: "success" }],
		});
		const result = routeAfterAlignment(state);
		expect(Array.isArray(result)).toBe(true);
	});

	test("stops retrying after max attempts", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			dataSourceResults: [{ dataSourceId: "elastic", data: "ok", status: "success" }],
			alignmentRetries: 2,
		});
		checkAlignment(state); // updates state
		expect(routeAfterAlignment(state)).toBe("aggregate");
	});
});

describe("validator", () => {
	test("passes valid answer referencing datasources", () => {
		const state = makeState({
			finalAnswer:
				"The elastic logs show error spikes at 14:30 UTC. The kafka consumer lag increased to 50k. The couchbase cluster reports high CPU. The konnect gateway shows 5xx errors.",
			dataSourceResults: [
				{ dataSourceId: "elastic", data: "error logs", status: "success" },
				{ dataSourceId: "kafka", data: "lag data", status: "success" },
				{ dataSourceId: "couchbase", data: "health data", status: "success" },
				{ dataSourceId: "konnect", data: "api data", status: "success" },
			],
		});
		const result = validate(state);
		expect(result.validationResult).toBe("pass");
	});

	test("fails empty answer", () => {
		const state = makeState({ finalAnswer: "" });
		const result = validate(state);
		expect(result.validationResult).toBe("fail");
	});

	test("fails too-short answer", () => {
		const state = makeState({ finalAnswer: "ok" });
		const result = validate(state);
		expect(result.validationResult).toBe("fail");
	});

	test("shouldRetryValidation respects max retries", () => {
		expect(shouldRetryValidation(makeState({ validationResult: "fail", retryCount: 0 }))).toBe(true);
		expect(shouldRetryValidation(makeState({ validationResult: "fail", retryCount: 1 }))).toBe(true);
		expect(shouldRetryValidation(makeState({ validationResult: "fail", retryCount: 2 }))).toBe(false);
		expect(shouldRetryValidation(makeState({ validationResult: "pass", retryCount: 0 }))).toBe(false);
	});
});

describe("supervisor", () => {
	test("fans out to extracted datasources", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "logs" },
					{ id: "kafka", mentionedAs: "kafka" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(2);
	});

	test("fans out to all datasources when none extracted", () => {
		const state = makeState({
			extractedEntities: { dataSources: [] },
			targetDataSources: [],
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(4);
	});

	test("respects UI-selected datasources", () => {
		const state = makeState({
			targetDataSources: ["elastic"],
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "logs" },
					{ id: "kafka", mentionedAs: "events" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(1);
	});

	test("deduplicates datasources", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "logs" },
					{ id: "elastic", mentionedAs: "elasticsearch" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(1);
	});
});
