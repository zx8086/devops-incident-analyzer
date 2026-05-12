// agent/src/supervisor-router.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";

const VALID_DATASOURCES = new Set(["elastic", "kafka", "couchbase", "konnect"]);
mock.module("./mcp-bridge.ts", () => ({
	getToolsForDataSource: (id: string) => (VALID_DATASOURCES.has(id) ? [{ name: `${id}_tool` }] : []),
	getAllTools: () => [],
	getConnectedServers: () => [...VALID_DATASOURCES],
}));

// Mock getAgent to return router delegation mode
mock.module("./prompt-context.ts", () => ({
	getAgent: () => ({
		manifest: { delegation: { mode: "router" } },
		tools: [],
		subAgents: new Map(),
	}),
	buildOrchestratorPrompt: () => "",
	buildSubAgentPrompt: () => "",
	getToolDefinitionForDataSource: () => undefined,
}));

import { supervise } from "./supervisor.ts";

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
		requestId: "test-router",
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

describe("supervisor router mode", () => {
	test("filters out fallback 'all' extractions, keeps confident ones", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "logs" },
					{ id: "kafka", mentionedAs: "all" },
					{ id: "couchbase", mentionedAs: "all" },
					{ id: "konnect", mentionedAs: "all" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(1);
		expect(sends[0]?.args.currentDataSource).toBe("elastic");
	});

	test("keeps all when query is genuinely broad (all have specific mentions)", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "elasticsearch logs" },
					{ id: "kafka", mentionedAs: "consumer lag" },
					{ id: "couchbase", mentionedAs: "database queries" },
					{ id: "konnect", mentionedAs: "api gateway" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(4);
	});

	test("keeps all when every source has mentionedAs 'all' (ambiguous query)", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "all" },
					{ id: "kafka", mentionedAs: "all" },
					{ id: "couchbase", mentionedAs: "all" },
					{ id: "konnect", mentionedAs: "all" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(4);
	});

	test("UI-selected datasources override router filtering", () => {
		const state = makeState({
			targetDataSources: ["elastic", "kafka"],
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "logs" },
					{ id: "kafka", mentionedAs: "all" },
					{ id: "couchbase", mentionedAs: "database" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(2);
		const dispatched = sends.map((s) => s.args.currentDataSource);
		expect(dispatched).toContain("elastic");
		expect(dispatched).toContain("kafka");
	});

	test("falls back to all datasources when nothing extracted", () => {
		const state = makeState({
			extractedEntities: { dataSources: [] },
			targetDataSources: [],
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(4);
	});

	test("filters multiple confident sources from mixed extractions", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [
					{ id: "elastic", mentionedAs: "error logs" },
					{ id: "kafka", mentionedAs: "consumer groups" },
					{ id: "couchbase", mentionedAs: "all" },
					{ id: "konnect", mentionedAs: "all" },
				],
			},
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(2);
		const dispatched = sends.map((s) => s.args.currentDataSource);
		expect(dispatched).toContain("elastic");
		expect(dispatched).toContain("kafka");
	});
});
