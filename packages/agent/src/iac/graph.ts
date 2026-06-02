// agent/src/iac/graph.ts
import { createCheckpointer } from "@devops-agent/checkpointer";
import { END, START, StateGraph } from "@langchain/langgraph";
import { initializeLangSmith } from "../langsmith.ts";
import {
	bootstrapIac,
	draftChange,
	guardNode,
	openMr,
	parseIntent,
	planReviewGate,
	readClusterState,
	reviewPlan,
	teardownIac,
} from "./nodes.ts";
import { IacState } from "./state.ts";

// Dedicated Elastic Cloud IaC maker graph. Every mutating/external step is gated;
// the planReview node is a human interrupt and the graph never applies (a human
// merges + applies from GitLab). Separate from the incident pipeline (buildGraph).
export async function buildIacGraph(config?: { checkpointerType?: "memory" | "sqlite" }) {
	await initializeLangSmith();

	const graph = new StateGraph(IacState)
		.addNode("bootstrap", bootstrapIac)
		.addNode("parseIntent", parseIntent)
		.addNode("readClusterState", readClusterState)
		.addNode("guard", guardNode)
		.addNode("draftChange", draftChange)
		.addNode("reviewPlan", reviewPlan)
		.addNode("reviewGate", planReviewGate)
		.addNode("openMr", openMr)
		.addNode("teardown", teardownIac)

		.addEdge(START, "bootstrap")
		// Not connected -> surface the message and stop.
		.addConditionalEdges("bootstrap", (s) => (s.connected ? "parseIntent" : END), ["parseIntent", END])
		.addEdge("parseIntent", "readClusterState")
		.addEdge("readClusterState", "guard")
		// Blocked by a mechanical safety guard -> stop before any write.
		.addConditionalEdges("guard", (s) => (s.blockedReason ? END : "draftChange"), ["draftChange", END])
		.addEdge("draftChange", "reviewPlan")
		.addEdge("reviewPlan", "reviewGate")
		// Human decision from the planReview interrupt routes to MR-open or stop.
		.addConditionalEdges("reviewGate", (s) => (s.reviewDecision === "approved" ? "openMr" : "teardown"), [
			"openMr",
			"teardown",
		])
		.addEdge("openMr", "teardown")
		.addEdge("teardown", END);

	const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
	return graph.compile({ checkpointer });
}
