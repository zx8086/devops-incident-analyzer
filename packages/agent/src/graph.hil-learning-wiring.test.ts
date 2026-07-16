// packages/agent/src/graph.hil-learning-wiring.test.ts
//
// SIO-1126: verify the HIL learning lane is registered and edged
// classify -> learnFetchTicket -> learnMatchIncident -> learnMatchGate ->
// learnDistill -> learnReviewGate -> applyLearnings -> END. The
// HIL_LEARNING_ENABLED gate lives in the classify ROUTER (runtime), not the
// structure, so the disabled case is covered by the isHilLearningEnabled unit
// tests + the classifier's turnReset clearing (detect.test.ts); here we assert
// the structural lane exists. Introspects the compiled graph (no live LLM/MCP).

import { describe, expect, test } from "bun:test";
import { isHilLearningEnabled } from "./learn/config.ts";

// biome-ignore lint/suspicious/noExplicitAny: LangGraph's drawable-graph shape is untyped here; we only read ids.
function edgeList(drawable: any): string[] {
	return (drawable.edges ?? []).map((e: { source: string; target: string }) => `${e.source}->${e.target}`);
}

describe("SIO-1126 HIL learning lane wiring", () => {
	test("lane nodes are registered and edged through to END", async () => {
		const { buildGraph } = await import("./graph.ts");
		const drawable = (await buildGraph()).getGraph();
		const edges = edgeList(drawable);
		// classify's conditional targets include the lane entry.
		expect(edges).toContain("classify->learnFetchTicket");
		// fetch success continues to matching; failure ends the lane.
		expect(edges).toContain("learnFetchTicket->learnMatchIncident");
		expect(edges).toContain("learnFetchTicket->__end__");
		// compute/gate split, then distill, review, apply, END.
		expect(edges).toContain("learnMatchIncident->learnMatchGate");
		expect(edges).toContain("learnMatchGate->learnDistill");
		expect(edges).toContain("learnDistill->learnReviewGate");
		expect(edges).toContain("learnDistill->__end__");
		expect(edges).toContain("learnReviewGate->applyLearnings");
		expect(edges).toContain("applyLearnings->__end__");
	});

	test("the lane never touches the investigation pipeline", async () => {
		const { buildGraph } = await import("./graph.ts");
		const drawable = (await buildGraph()).getGraph();
		const edges = edgeList(drawable);
		for (const edge of edges) {
			const [source, target] = edge.split("->");
			if (source?.startsWith("learn") || source === "applyLearnings") {
				expect([
					"learnFetchTicket",
					"learnMatchIncident",
					"learnMatchGate",
					"learnDistill",
					"learnReviewGate",
					"applyLearnings",
					"__end__",
				]).toContain(target ?? "");
			}
		}
	});
});

describe("SIO-1126 isHilLearningEnabled", () => {
	test("defaults ON; kill switch via false/0", () => {
		expect(isHilLearningEnabled({} as NodeJS.ProcessEnv)).toBe(true);
		expect(isHilLearningEnabled({ HIL_LEARNING_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isHilLearningEnabled({ HIL_LEARNING_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
		expect(isHilLearningEnabled({ HIL_LEARNING_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
	});
});
