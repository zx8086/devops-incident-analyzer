// packages/agent/src/supervisor-aws-fanout.test.ts
// SIO-760: assert supervise() dispatches 6 Sends when all 6 datasources are
// connected and named in extractedEntities. This is the Phase 4 gate.
import { describe, expect, mock, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";

const ALL_SIX = new Set(["elastic", "kafka", "couchbase", "konnect", "gitlab", "aws"]);

mock.module("./mcp-bridge.ts", () => ({
	getToolsForDataSource: (id: string) => (ALL_SIX.has(id) ? [{ name: `${id}_tool` }] : []),
	getAllTools: () => [],
	getConnectedServers: () => [...ALL_SIX].map((id) => `${id === "couchbase" ? "couchbase" : id}-mcp`),
	// DATASOURCE_TO_MCP_SERVER is needed at module load by some agent code paths.
	DATASOURCE_TO_MCP_SERVER: {
		elastic: "elastic-mcp",
		kafka: "kafka-mcp",
		couchbase: "couchbase-mcp",
		konnect: "konnect-mcp",
		gitlab: "gitlab-mcp",
		atlassian: "atlassian-mcp",
		aws: "aws-mcp",
	},
}));

mock.module("./prompt-context.ts", () => ({
	getAgent: () => ({
		manifest: { delegation: { mode: "auto" } },
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
		extractedEntities: {
			dataSources: [
				{ id: "elastic", mentionedAs: "explicit" },
				{ id: "kafka", mentionedAs: "explicit" },
				{ id: "couchbase", mentionedAs: "explicit" },
				{ id: "konnect", mentionedAs: "explicit" },
				{ id: "gitlab", mentionedAs: "explicit" },
				{ id: "aws", mentionedAs: "explicit" },
			],
		},
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
		investigationFocus: undefined,
		pendingTopicShiftPrompt: undefined,
		requestId: "test-fanout",
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

describe("supervisor AWS fan-out", () => {
	test("complex incident with all 6 sources connected dispatches 6 Sends including aws", () => {
		// biome-ignore lint/suspicious/noExplicitAny: test harness state shape matches AgentStateType at runtime
		const sends = supervise(makeState() as any);

		expect(sends).toHaveLength(6);

		// Each Send dispatches to the queryDataSource node with currentDataSource set.
		const targetSources = sends.map((s) => s.args.currentDataSource).sort();
		expect(targetSources).toContain("aws");

		// Verify all 6 expected datasources are present.
		expect(targetSources).toEqual(["aws", "couchbase", "elastic", "gitlab", "kafka", "konnect"]);
	});

	test("when aws is the only requested source, supervisor dispatches a single Send for aws", () => {
		const state = makeState({
			extractedEntities: {
				dataSources: [{ id: "aws", mentionedAs: "explicit" }],
			},
		});
		// biome-ignore lint/suspicious/noExplicitAny: same as above
		const sends = supervise(state as any);

		expect(sends).toHaveLength(1);
		expect(sends[0]?.args.currentDataSource).toBe("aws");
	});
});
