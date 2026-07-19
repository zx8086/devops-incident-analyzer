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
			confidencePreCap: undefined,
			capReasons: [] as string[],
			confirmedDegradingGapBullets: [] as string[],
			correlationFetchDirective: undefined,
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

// SIO-1155: the log-gap recovery path. A satisfied targeted elastic fetch rewrites
// the recovered Gaps bullets and restores the pre-cap confidence only when the gaps
// cap was the aggregate's sole cap reason and the judge-confirmed remainder falls
// below the threshold.
import { LOG_GAP_RULE_NAME } from "./rules.ts";

const STOCK_BULLET =
	"- `stock-service` internal logs at 03:09-03:20 UTC on failure nights were not retrieved; the exact internal error causing the HTTP 500 is unconfirmed";
const ORBIT_BULLET =
	"- GitLab Orbit knowledge graph was unavailable for all three `gitlab_blast_radius` calls; cross-project import edges were not derived";

function makeLogGapState(overrides: Record<string, unknown> = {}) {
	const finalAnswer = `# Incident Report

## Findings
- strong evidence.

## Gaps

${STOCK_BULLET}
${ORBIT_BULLET}

Confidence: 0.59`;
	return {
		messages: [],
		dataSourceResults: [
			// The targeted correlation fetch landed: elastic now covers stock-service.
			{
				dataSourceId: "elastic",
				status: "success" as const,
				data: "Targeted fetch: stock-service 4,812 error hits in logs-apm.error-*; latest 03:13:19Z.",
				toolErrors: [],
			},
		],
		extractedEntities: { dataSources: [] },
		confidenceCap: 0.59,
		degradedRules: [],
		pendingCorrelations: [
			{
				ruleName: LOG_GAP_RULE_NAME,
				requiredAgent: "elastic-agent" as const,
				triggerContext: { services: ["stock-service"], bullets: [STOCK_BULLET] },
				attemptsRemaining: 1,
				timeoutMs: 30_000,
			},
		],
		targetDataSources: [] as string[],
		retryCount: 0,
		alignmentRetries: 0,
		skippedDataSources: [] as string[],
		isFollowUp: false,
		finalAnswer,
		requestId: "test-sio1155",
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		mitigationFragments: [],
		confidenceScore: 0.59,
		confidencePreCap: 0.87,
		capReasons: ["gaps"] as string[],
		confirmedDegradingGapBullets: [STOCK_BULLET, ORBIT_BULLET] as string[],
		correlationFetchDirective: undefined,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		partialFailures: [],
		...overrides,
	} as never;
}

describe("SIO-1155 log-gap recovery in enforceCorrelationsAggregate", () => {
	test("satisfied fetch rewrites the recovered bullet and restores the pre-cap confidence", async () => {
		const result = await enforceCorrelationsAggregate(makeLogGapState());
		expect(result.finalAnswer).toContain(`${STOCK_BULLET} -- recovered via elastic`);
		expect(result.finalAnswer).toContain(ORBIT_BULLET); // untouched
		// stock recovered -> confirmed remainder is [orbit] = 1 < threshold 2 -> restore.
		expect(result.confidenceScore).toBe(0.87);
		expect(result.finalAnswer).toContain("Confidence: 0.87");
		expect(result.finalAnswer).not.toContain("Confidence: 0.59");
		expect(result.degradedRules).toEqual([]);
	});

	test("no restore when the gaps cap was not the sole cap reason", async () => {
		const result = await enforceCorrelationsAggregate(makeLogGapState({ capReasons: ["gaps", "premature-absence"] }));
		expect(result.finalAnswer).toContain("recovered via elastic");
		expect(result.confidenceScore).toBeUndefined(); // score untouched (stays capped in state)
	});

	test("no restore when the confirmed remainder still meets the threshold", async () => {
		const extra = "- `catalog-service` request logs query timed out and could not complete.";
		const result = await enforceCorrelationsAggregate(
			makeLogGapState({ confirmedDegradingGapBullets: [STOCK_BULLET, ORBIT_BULLET, extra] }),
		);
		expect(result.finalAnswer).toContain("recovered via elastic");
		expect(result.confidenceScore).toBeUndefined();
	});

	test("unsatisfied fetch (no elastic coverage) degrades and caps instead of recovering", async () => {
		const result = await enforceCorrelationsAggregate(
			makeLogGapState({
				dataSourceResults: [
					{ dataSourceId: "elastic", status: "success" as const, data: "no matching services found", toolErrors: [] },
				],
				confidenceScore: 0.87,
				capReasons: [] as string[],
			}),
		);
		expect(result.degradedRules?.map((d) => d.ruleName)).toContain(LOG_GAP_RULE_NAME);
		expect(result.confidenceScore).toBe(0.59);
		expect(result.finalAnswer).not.toContain("recovered via elastic");
	});

	test("router attaches the targeted fetch directive to the elastic Send", () => {
		const state = makeLogGapState({
			pendingCorrelations: [],
			dataSourceResults: [],
		});
		const result = enforceCorrelationsRouter(state);
		expect(Array.isArray(result)).toBe(true);
		if (!Array.isArray(result)) throw new Error("expected Send[]");
		const elasticSend = result.find((s) => s.args.currentDataSource === "elastic");
		expect(elasticSend).toBeDefined();
		expect(String(elasticSend?.args.correlationFetchDirective)).toContain("CORRELATION FETCH (SIO-1155)");
		expect(String(elasticSend?.args.correlationFetchDirective)).toContain("stock-service");
	});
});
