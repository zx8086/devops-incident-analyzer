// packages/agent/src/investigation-focus.test.ts
//
// SIO-750: unit tests for buildInvestigationFocus. The investigation focus is
// the anchor that keeps multi-turn chat sessions scoped to the same
// investigation across turns. The bug we are fixing: turn 1 about styles-v3
// + turn 2 "is kafka still failing?" was producing a sprawling unrelated
// report because no focus was preserved across turns.

import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { buildInvestigationFocus } from "./normalizer.ts";
import type { AgentStateType } from "./state.ts";

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [new HumanMessage("turn 1")],
		queryComplexity: "complex",
		targetDataSources: [],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults: [],
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
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
		partialFailures: [],
		investigationFocus: undefined,
		pendingTopicShiftPrompt: undefined,
		...overrides,
	} as AgentStateType;
}

describe("buildInvestigationFocus (SIO-750)", () => {
	test("turn 1: builds from incident services + timeWindow", () => {
		const state = makeState({ messages: [new HumanMessage("check styles-v3 over-fetch")] });
		const incident = {
			severity: "high" as const,
			timeWindow: { from: "2026-05-14T17:00:00Z", to: "2026-05-14T18:00:00Z" },
			affectedServices: [{ name: "pvh-services-styles-v3" }],
		};

		const focus = buildInvestigationFocus(state, incident, "check styles-v3 over-fetch");

		expect(focus.services).toEqual(["pvh-services-styles-v3"]);
		expect(focus.datasources).toEqual([]); // stage 2 fills this in
		expect(focus.timeWindow).toEqual({ from: "2026-05-14T17:00:00Z", to: "2026-05-14T18:00:00Z" });
		expect(focus.summary).toContain("high");
		expect(focus.summary).toContain("pvh-services-styles-v3");
		expect(focus.summary).toContain("check styles-v3 over-fetch");
		expect(focus.establishedAtTurn).toBe(1);
	});

	test("turn 1 with no severity: summary uses 'unspecified'", () => {
		const state = makeState();
		const focus = buildInvestigationFocus(state, { affectedServices: [{ name: "foo" }] }, "investigate foo");
		expect(focus.summary).toContain("unspecified");
		expect(focus.summary).toContain("foo");
	});

	test("turn 1 with no services: summary still builds (degenerate but valid)", () => {
		const state = makeState();
		const focus = buildInvestigationFocus(state, { severity: "medium" }, "general health check");
		expect(focus.services).toEqual([]);
		expect(focus.summary).toContain("medium investigation");
		expect(focus.summary).toContain("general health check");
	});

	test("summary truncates the query snippet to 80 chars and collapses whitespace", () => {
		const longQuery = "investigate the\nover-fetch  bug   in styles-v3 ".repeat(10);
		const state = makeState({ messages: [new HumanMessage(longQuery)] });
		const focus = buildInvestigationFocus(state, { severity: "high" }, longQuery);
		// The "<severity> investigation -- <snippet>" prefix is ~28 chars; the
		// snippet itself should be capped at 80, so summary length stays bounded.
		expect(focus.summary.length).toBeLessThanOrEqual(28 + 80 + 4);
		// Newlines and runs of spaces collapse to single spaces.
		expect(focus.summary).not.toContain("\n");
		expect(focus.summary).not.toMatch(/ {2}/);
	});

	test("establishedAtTurn reflects the current message count", () => {
		const state = makeState({
			messages: [
				new HumanMessage("turn 1 message"),
				new HumanMessage("turn 2 (the system would route this through follow-up)"),
				new HumanMessage("turn 3"),
			],
		});
		const focus = buildInvestigationFocus(state, {}, "turn 3");
		expect(focus.establishedAtTurn).toBe(3);
	});

	// Cold-restart recovery: server restarted, checkpointer lost the focus,
	// but the UI sent isFollowUp:true. We rebuild from the current incident
	// rather than crashing or returning undefined.
	test("isFollowUp:true with no prior focus: reconstructs and logs warning", () => {
		const state = makeState({
			isFollowUp: true,
			investigationFocus: undefined,
			messages: [new HumanMessage("turn 1"), new HumanMessage("turn 2 -- cold restart")],
		});
		const focus = buildInvestigationFocus(state, { affectedServices: [{ name: "svc-a" }] }, "turn 2 -- cold restart");
		// Reconstruction succeeded; the focus is buildable even though it
		// arrived on a follow-up turn without a prior focus persisted.
		expect(focus.services).toEqual(["svc-a"]);
		expect(focus.establishedAtTurn).toBe(2);
	});
});
