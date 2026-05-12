// packages/agent/src/graph.send-mitigation.test.ts
//
// SIO-741: integration-style coverage for the validate -> parallel mitigation
// branches dispatcher. We exercise the exported routeAfterValidate function
// (the conditional edge handler) and assert the three Send targets join at
// aggregateMitigation. Avoids booting the full compiled graph since that
// requires real LLM + MCP wiring.

import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { Send } from "@langchain/langgraph";
import { routeAfterValidate } from "./graph.ts";

function makeState(overrides: Record<string, unknown> = {}) {
	return {
		messages: [],
		attachmentMeta: [],
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
		finalAnswer: "a real answer".repeat(20),
		dataSourceContext: undefined,
		requestId: "test-741",
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		mitigationFragments: [],
		confidenceScore: 0.7,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		partialFailures: [],
		...overrides,
		// biome-ignore lint/suspicious/noExplicitAny: test helper; cast keeps the helper terse without redeclaring AgentStateType locally
	} as any;
}

describe("routeAfterValidate (SIO-741)", () => {
	test("returns 'aggregate' when validation should retry", () => {
		const state = makeState({ validationResult: "fail", retryCount: 0 });
		expect(routeAfterValidate(state)).toBe("aggregate");
	});

	test("dispatches three Send objects targeting the parallel mitigation branches when validation passes", () => {
		const state = makeState({ validationResult: "pass", retryCount: 0 });
		const result = routeAfterValidate(state);

		expect(Array.isArray(result)).toBe(true);
		if (!Array.isArray(result)) throw new Error("expected Send[] but got string target");

		expect(result).toHaveLength(3);
		expect(result.every((s) => s instanceof Send)).toBe(true);

		const nodeNames = result.map((s) => s.node).sort();
		expect(nodeNames).toEqual(["proposeEscalate", "proposeInvestigate", "proposeMonitor"]);
	});

	test("each Send carries the full state payload (so branches see finalAnswer + targetDataSources)", () => {
		const state = makeState({
			validationResult: "pass",
			retryCount: 0,
			targetDataSources: ["elastic", "kafka"],
		});
		const result = routeAfterValidate(state);
		if (!Array.isArray(result)) throw new Error("expected Send[]");

		for (const send of result) {
			expect(send.args).toMatchObject({
				finalAnswer: state.finalAnswer,
				targetDataSources: ["elastic", "kafka"],
			});
		}
	});

	test("retry-path falls back to aggregate even when validation result is 'fail' with retries remaining", () => {
		expect(routeAfterValidate(makeState({ validationResult: "fail", retryCount: 1 }))).toBe("aggregate");
	});
});
