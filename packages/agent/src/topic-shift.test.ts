// packages/agent/src/topic-shift.test.ts
//
// SIO-751: unit tests for the topic-shift detection node. The interrupt()
// call inside detectTopicShift only works when invoked inside a running
// LangGraph execution -- outside of one it throws "called outside the
// context of a graph". So the tests here focus on:
//   1. The pure structural overlap helper (_testOnly.isTopicShift)
//   2. The candidate builder (_testOnly.buildCandidate)
//   3. The node's no-op fast paths (no focus, not a follow-up, overlap present)
// The integration test covers the actual interrupt + resume round-trip.

import { describe, expect, test } from "bun:test";
import type { InvestigationFocus } from "@devops-agent/shared";
import { HumanMessage } from "@langchain/core/messages";
import type { AgentStateType } from "./state.ts";
import { _testOnly, detectTopicShift } from "./topic-shift.ts";

const { buildCandidate, isTopicShift } = _testOnly;

function makeFocus(overrides: Partial<InvestigationFocus> = {}): InvestigationFocus {
	return {
		services: ["pvh-services-styles-v3"],
		datasources: ["elastic", "kafka", "couchbase"],
		timeWindow: { from: "2026-05-14T17:00:00Z", to: "2026-05-14T18:00:00Z" },
		summary: "high investigation of pvh-services-styles-v3 -- styles-v3 over-fetch",
		establishedAtTurn: 1,
		...overrides,
	};
}

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

describe("isTopicShift (structural overlap)", () => {
	test("datasource overlap -> not a shift", () => {
		const focus = makeFocus();
		expect(isTopicShift(focus, ["kafka"], ["unrelated-service"])).toBe(false);
	});

	test("service overlap -> not a shift", () => {
		const focus = makeFocus();
		expect(isTopicShift(focus, ["gitlab"], ["pvh-services-styles-v3"])).toBe(false);
	});

	test("service overlap is case-insensitive", () => {
		const focus = makeFocus({ services: ["pvh-services-styles-v3"] });
		expect(isTopicShift(focus, ["gitlab"], ["PVH-Services-Styles-v3"])).toBe(false);
	});

	test("no overlap and new services present -> shift", () => {
		const focus = makeFocus();
		expect(isTopicShift(focus, ["gitlab"], ["some-other-service"])).toBe(true);
	});

	test("no overlap but no new services -> not a shift (pure anaphoric follow-up)", () => {
		const focus = makeFocus();
		// "is kafka still failing?" extracts no service names; only a pronoun.
		// We must not treat this as a topic shift.
		expect(isTopicShift(focus, ["kafka"], [])).toBe(false);
		expect(isTopicShift(focus, [], [])).toBe(false);
	});
});

describe("buildCandidate", () => {
	test("builds focus from current incident + datasources", () => {
		const state = makeState({ messages: [new HumanMessage("show me MARS-127 jira tickets")] });
		const candidate = buildCandidate(state, { severity: "low", affectedServices: [{ name: "jira-mars" }] }, [
			"atlassian",
		]);

		expect(candidate.services).toEqual(["jira-mars"]);
		expect(candidate.datasources).toEqual(["atlassian"]);
		expect(candidate.summary).toContain("low");
		expect(candidate.summary).toContain("jira-mars");
		expect(candidate.summary).toContain("MARS-127");
	});

	test("degenerate input (no services) still produces a summary", () => {
		const state = makeState();
		const candidate = buildCandidate(state, {}, []);
		expect(candidate.summary).toContain("unspecified");
	});
});

describe("detectTopicShift node (no-op paths)", () => {
	test("no focus -> returns {} (first turn, nothing to compare)", () => {
		const state = makeState({ isFollowUp: false, investigationFocus: undefined });
		expect(detectTopicShift(state)).toEqual({});
	});

	test("not a follow-up -> returns {} even if a focus exists", () => {
		// Theoretical case: focus was carried in via state but isFollowUp is false.
		// The node skips detection rather than interrupting on an apparent "turn 1".
		const state = makeState({ isFollowUp: false, investigationFocus: makeFocus() });
		expect(detectTopicShift(state)).toEqual({});
	});

	test("datasource overlap -> returns {} (no interrupt)", () => {
		const state = makeState({
			isFollowUp: true,
			investigationFocus: makeFocus(),
			normalizedIncident: { affectedServices: [{ name: "unrelated" }] },
			extractedEntities: { dataSources: [{ id: "kafka", mentionedAs: "kafka" }] },
		});
		expect(detectTopicShift(state)).toEqual({});
	});

	test("service overlap -> returns {} (no interrupt)", () => {
		const state = makeState({
			isFollowUp: true,
			investigationFocus: makeFocus(),
			normalizedIncident: { affectedServices: [{ name: "pvh-services-styles-v3" }] },
			extractedEntities: { dataSources: [{ id: "atlassian", mentionedAs: "atlassian" }] },
		});
		expect(detectTopicShift(state)).toEqual({});
	});

	test("anaphoric follow-up with no new services -> returns {} (no interrupt)", () => {
		// This is the exact "is kafka still failing?" case that motivated SIO-748.
		// The user's turn 2 extracts no service names; we must not classify it
		// as a topic shift and must not interrupt.
		const state = makeState({
			isFollowUp: true,
			messages: [new HumanMessage("turn 1"), new HumanMessage("is kafka still failing?")],
			investigationFocus: makeFocus(),
			normalizedIncident: {}, // no affectedServices extracted
			extractedEntities: { dataSources: [{ id: "kafka", mentionedAs: "kafka" }] },
		});
		expect(detectTopicShift(state)).toEqual({});
	});
});

// Note: the interrupt + resume round-trip is covered by the integration test
// because interrupt() requires a graph execution context. See
// packages/agent/tests/cross-turn-focus.test.ts (when added).
