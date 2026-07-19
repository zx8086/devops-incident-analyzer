// agent/src/supervisor-router.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";

// SIO-1142: `aws` is connected here so the empty-estate skip can be exercised
// (an unconnected AWS would already be skipped as "not connected", hiding the bug).
const VALID_DATASOURCES = new Set(["elastic", "kafka", "couchbase", "konnect", "aws"]);
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
	// SIO-1040: aggregate() reads the split builder; keep it stubbed in lock-step.
	buildOrchestratorPromptParts: () => ({ stable: "", volatile: "" }),
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
		awsTargetEstates: [] as string[],
		uiAwsEstates: [] as string[],
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
		graphContext: "",
		graphBlastRadius: [],
		dataSourceContext: undefined,
		requestId: "test-router",
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		mitigationFragments: [],
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
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		partialFailures: [],
		investigationFocus: undefined,
		resolvedIdentifiers: undefined,
		pendingTopicShiftPrompt: undefined,
		hilLearnTicketKey: undefined,
		hilTicket: undefined,
		hilMatchCandidates: [],
		hilTicketEmbedding: undefined,
		hilMatch: undefined,
		hilProposal: undefined,
		hilAlreadyLearned: false,
		hilDecisions: undefined,
		hilEdits: {},
		hilApplyReport: undefined,
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
			// SIO-1142: AWS is connected in this suite, so fallback-all includes it;
			// give it an estate so the empty-estate skip doesn't drop it here.
			awsTargetEstates: ["eu-oit-prd"],
		});
		const sends = supervise(state);
		expect(sends).toHaveLength(5);
		expect(sends.map((s) => s.args.currentDataSource)).toContain("aws");
	});

	// SIO-1142: AWS in scope + connected tools but empty awsTargetEstates must be
	// skipped, not dispatched -- otherwise queryDataSource runs the sub-agent outside
	// any withAwsEstate scope and every AWS tool throws the estate-scope guard.
	test("skips AWS when awsTargetEstates is empty (no scope to dispatch into)", () => {
		const state = makeState({
			targetDataSources: ["elastic", "aws"],
			awsTargetEstates: [],
		});
		const sends = supervise(state);
		const dispatched = sends.map((s) => s.args.currentDataSource);
		expect(dispatched).toContain("elastic");
		expect(dispatched).not.toContain("aws");
		// The skip reason is threaded to the aggregator via skippedDataSources.
		const skipped = (sends[0]?.args as { skippedDataSources?: string[] }).skippedDataSources ?? [];
		expect(skipped.some((r) => /aws: no estates resolved/.test(r))).toBe(true);
	});

	test("dispatches AWS when awsTargetEstates is non-empty", () => {
		const state = makeState({
			targetDataSources: ["elastic", "aws"],
			awsTargetEstates: ["eu-oit-prd"],
		});
		const sends = supervise(state);
		const dispatched = sends.map((s) => s.args.currentDataSource);
		expect(dispatched).toContain("aws");
		const skipped = (sends[0]?.args as { skippedDataSources?: string[] }).skippedDataSources ?? [];
		expect(skipped.some((r) => /aws: no estates resolved/.test(r))).toBe(false);
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
