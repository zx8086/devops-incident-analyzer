// packages/agent/src/correlation/integration.test.ts
// Pipeline integration test: an aws-agent prose claiming an ECS service is
// degraded must drive enforceCorrelationsRouter to dispatch an elastic-agent
// Send via the aws-ecs-degraded-needs-elastic-traces rule.
import { describe, expect, mock, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";

// Mock the mcp-bridge so the router thinks all servers are connected.
mock.module("../mcp-bridge.ts", () => ({
	getToolsForDataSource: () => [{ name: "fake_tool" }],
	getAllTools: () => [],
	getConnectedServers: () => ["elastic-mcp", "kafka-mcp", "couchbase-mcp", "konnect-mcp", "gitlab-mcp", "aws-mcp"],
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

mock.module("../prompt-context.ts", () => ({
	getAgent: () => ({
		manifest: { delegation: { mode: "auto" } },
		tools: [],
		subAgents: new Map(),
	}),
	buildOrchestratorPrompt: () => "",
	buildSubAgentPrompt: () => "",
	getToolDefinitionForDataSource: () => undefined,
}));

import { enforceCorrelationsAggregate, enforceCorrelationsRouter } from "./enforce-node.ts";

function makeDegradingState(finalAnswer: string, confidenceScore: number) {
	// A pending correlation for a rule that stays unsatisfied (no elastic findings
	// cover the triggered AWS entity), so enforceCorrelationsAggregate caps confidence.
	return {
		messages: [],
		dataSourceResults: [
			{
				dataSourceId: "aws",
				status: "success",
				data: "ECS service backend: 0 of 5 tasks running.",
				toolErrors: [],
			},
		],
		extractedEntities: { dataSources: [{ id: "aws", mentionedAs: "explicit" as const }] },
		confidenceCap: undefined,
		degradedRules: [],
		pendingCorrelations: [
			{
				ruleName: "aws-ecs-degraded-needs-elastic-traces",
				requiredAgent: "elastic-agent" as const,
				triggerContext: { service: "backend" },
			},
		],
		targetDataSources: [] as string[],
		retryCount: 0,
		alignmentRetries: 0,
		skippedDataSources: [] as string[],
		isFollowUp: false,
		finalAnswer,
		requestId: "test-sio860",
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		mitigationFragments: [],
		confidenceScore,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		partialFailures: [],
	} as never;
}

describe("enforceCorrelationsAggregate confidence rewrite (SIO-860)", () => {
	test("rewrites the printed confidence to the capped value when a rule degrades", async () => {
		const state = makeDegradingState("# Report\n\n## Findings\n- a\n\nConfidence: 0.9", 0.9);
		const result = await enforceCorrelationsAggregate(state);
		expect(result.confidenceScore).toBe(0.59);
		expect(result.confidenceCap).toBe(0.59);
		expect(result.finalAnswer).toContain("Confidence: 0.59");
		expect(result.finalAnswer).not.toContain("Confidence: 0.9");
	});
});

describe("Phase 5 correlation rules — pipeline integration", () => {
	test("aws-agent ECS-degraded prose dispatches elastic-agent Send", () => {
		const awsResult: DataSourceResult = {
			dataSourceId: "aws",
			status: "success",
			data: "ECS service backend: 0 of 5 tasks running. Last event 'CannotPullContainerError'.",
			toolErrors: [],
		};

		const state = {
			messages: [],
			dataSourceResults: [awsResult],
			extractedEntities: { dataSources: [{ id: "aws", mentionedAs: "explicit" as const }] },
			confidenceCap: undefined,
			degradedRules: [],
			pendingCorrelations: [],
			targetDataSources: [] as string[],
			retryCount: 0,
			alignmentRetries: 0,
			skippedDataSources: [] as string[],
			isFollowUp: false,
			finalAnswer: "",
			requestId: "test-phase5",
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
			partialFailures: [],
		} as never;

		const result = enforceCorrelationsRouter(state);

		// Router returns Send[] when one or more rules need invocation.
		expect(Array.isArray(result)).toBe(true);
		if (!Array.isArray(result)) throw new Error("expected Send[]");

		// At least one Send must target the elastic datasource (the rule's requiredAgent).
		const targets = result.map((s) => s.args.currentDataSource);
		expect(targets).toContain("elastic");
	});
});
