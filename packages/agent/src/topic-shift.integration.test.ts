// packages/agent/src/topic-shift.integration.test.ts
//
// SIO-751: light integration test for the interrupt() -> Command({resume})
// round-trip inside a running LangGraph execution. We build a minimal
// 2-node graph (entityExtractor stub -> detectTopicShift -> END) so we can
// exercise the actual graph runtime without booting the full agent pipeline.
//
// What this catches that the unit tests can't:
//   - interrupt() actually throws GraphInterrupt when invoked inside a node
//   - Command({ resume }) actually returns the resume value to interrupt()'s caller
//   - The "fresh" branch's state updates (investigationFocus, finalAnswer) actually
//     reach the post-resume state snapshot
//   - getState({ thread_id }) actually surfaces pending interrupts via tasks[].interrupts[]

import { describe, expect, test } from "bun:test";
import type { InvestigationFocus } from "@devops-agent/shared";
import { HumanMessage } from "@langchain/core/messages";
import { Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { AgentState, type AgentStateType } from "./state.ts";
import { detectTopicShift } from "./topic-shift.ts";

function focusOf(svc: string, ds: string): InvestigationFocus {
	return {
		services: [svc],
		datasources: [ds],
		timeWindow: { from: "2026-05-14T17:00:00Z", to: "2026-05-14T18:00:00Z" },
		summary: `high investigation of ${svc}`,
		establishedAtTurn: 1,
	};
}

// Minimal graph: START -> seed (a passthrough stub) -> detectTopicShift -> END.
// We pass full state in to .invoke() so the seed stub doesn't have to populate
// anything itself.
function buildMiniGraph() {
	const graph = new StateGraph(AgentState)
		.addNode("seed", (_state: AgentStateType) => ({}))
		.addNode("detectTopicShift", detectTopicShift)
		.addEdge(START, "seed")
		.addEdge("seed", "detectTopicShift")
		.addEdge("detectTopicShift", END);
	return graph.compile({ checkpointer: new MemorySaver() });
}

describe("detectTopicShift interrupt round-trip (SIO-751)", () => {
	test("zero-overlap turn pauses graph; getState surfaces pending interrupt", async () => {
		const compiled = buildMiniGraph();
		const config = { configurable: { thread_id: `t-shift-${Date.now()}` } };

		// State that triggers a shift: focus on svc-a/elastic, new turn has
		// svc-b and datasource gitlab. No overlap on either axis.
		const inputState = {
			messages: [new HumanMessage("turn 1"), new HumanMessage("turn 2: pivot")],
			isFollowUp: true,
			investigationFocus: focusOf("svc-a", "elastic"),
			normalizedIncident: { affectedServices: [{ name: "svc-b" }] },
			extractedEntities: { dataSources: [{ id: "gitlab", mentionedAs: "gitlab" }] },
			targetDataSources: [],
			targetDeployments: [],
			retryDeployments: [],
			dataSourceResults: [],
			currentDataSource: "",
			queryComplexity: "complex" as const,
			toolPlanMode: "autonomous" as const,
			toolPlan: [],
			validationResult: "pass" as const,
			retryCount: 0,
			alignmentRetries: 0,
			alignmentHints: [],
			skippedDataSources: [],
			finalAnswer: "prior styles-v3 report",
			previousEntities: { dataSources: [] },
			requestId: "test",
			attachmentMeta: [],
			suggestions: [],
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
			pendingTopicShiftPrompt: undefined,
		};

		// First invoke: graph pauses on interrupt() inside detectTopicShift.
		// invoke() returns when the graph completes OR pauses; getState tells us
		// which. The state schema's inferred input type from LangGraph generics
		// is too complex to reproduce locally; cast through unknown.
		await compiled.invoke(inputState as unknown as Parameters<typeof compiled.invoke>[0], config);
		const snapshot = await compiled.getState(config);
		const tasks = (snapshot.tasks ?? []) as Array<{
			interrupts?: Array<{ value: unknown }>;
		}>;
		const interrupts = tasks.flatMap((t) => t.interrupts ?? []);
		expect(interrupts.length).toBe(1);

		const payload = interrupts[0]?.value as {
			type: string;
			oldFocus: InvestigationFocus;
			newFocusCandidate: InvestigationFocus;
		};
		expect(payload.type).toBe("topic_shift");
		expect(payload.oldFocus.services).toEqual(["svc-a"]);
		expect(payload.newFocusCandidate.services).toEqual(["svc-b"]);

		// Resume with "continue" -- focus preserved, finalAnswer untouched.
		// Command's exported type is not narrow enough for the streamEvents
		// overload; cast through unknown.
		const continueInput = new Command({ resume: { decision: "continue" } }) as unknown as Parameters<
			typeof compiled.invoke
		>[0];
		await compiled.invoke(continueInput, config);
		const after = await compiled.getState(config);
		expect((after.values as AgentStateType).investigationFocus?.services).toEqual(["svc-a"]);
		expect((after.values as AgentStateType).finalAnswer).toBe("prior styles-v3 report");
	});

	test("zero-overlap turn resumed with 'fresh' replaces focus and clears finalAnswer", async () => {
		const compiled = buildMiniGraph();
		const config = { configurable: { thread_id: `t-fresh-${Date.now()}` } };

		const inputState = {
			messages: [new HumanMessage("turn 1"), new HumanMessage("turn 2: new investigation")],
			isFollowUp: true,
			investigationFocus: focusOf("svc-a", "elastic"),
			normalizedIncident: { severity: "low" as const, affectedServices: [{ name: "svc-b" }] },
			extractedEntities: { dataSources: [{ id: "gitlab", mentionedAs: "gitlab" }] },
			targetDataSources: [],
			targetDeployments: [],
			retryDeployments: [],
			dataSourceResults: [],
			currentDataSource: "",
			queryComplexity: "complex" as const,
			toolPlanMode: "autonomous" as const,
			toolPlan: [],
			validationResult: "pass" as const,
			retryCount: 0,
			alignmentRetries: 0,
			alignmentHints: [],
			skippedDataSources: [],
			finalAnswer: "prior styles-v3 report",
			previousEntities: { dataSources: [] },
			requestId: "test",
			attachmentMeta: [],
			suggestions: [],
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
			pendingTopicShiftPrompt: undefined,
		};

		// See test 1 comments for the unknown-cast rationale.
		await compiled.invoke(inputState as unknown as Parameters<typeof compiled.invoke>[0], config);
		const freshInput = new Command({ resume: { decision: "fresh" } }) as unknown as Parameters<
			typeof compiled.invoke
		>[0];
		await compiled.invoke(freshInput, config);

		const after = await compiled.getState(config);
		const finalState = after.values as AgentStateType;
		expect(finalState.investigationFocus?.services).toEqual(["svc-b"]);
		expect(finalState.finalAnswer).toBe("");
	});

	test("overlap on service: graph completes without interrupting", async () => {
		const compiled = buildMiniGraph();
		const config = { configurable: { thread_id: `t-overlap-${Date.now()}` } };

		const inputState = {
			messages: [new HumanMessage("turn 1"), new HumanMessage("more about svc-a?")],
			isFollowUp: true,
			investigationFocus: focusOf("svc-a", "elastic"),
			normalizedIncident: { affectedServices: [{ name: "svc-a" }] },
			extractedEntities: { dataSources: [{ id: "kafka", mentionedAs: "kafka" }] },
			targetDataSources: [],
			targetDeployments: [],
			retryDeployments: [],
			dataSourceResults: [],
			currentDataSource: "",
			queryComplexity: "complex" as const,
			toolPlanMode: "autonomous" as const,
			toolPlan: [],
			validationResult: "pass" as const,
			retryCount: 0,
			alignmentRetries: 0,
			alignmentHints: [],
			skippedDataSources: [],
			finalAnswer: "",
			previousEntities: { dataSources: [] },
			requestId: "test",
			attachmentMeta: [],
			suggestions: [],
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
			pendingTopicShiftPrompt: undefined,
		};

		// See test 1 comments for the unknown-cast rationale.
		await compiled.invoke(inputState as unknown as Parameters<typeof compiled.invoke>[0], config);

		const snapshot = await compiled.getState(config);
		const tasks = (snapshot.tasks ?? []) as Array<{ interrupts?: Array<{ value: unknown }> }>;
		const interrupts = tasks.flatMap((t) => t.interrupts ?? []);
		expect(interrupts.length).toBe(0);
		// Focus untouched, no shift.
		expect((snapshot.values as AgentStateType).investigationFocus?.services).toEqual(["svc-a"]);
	});
});
