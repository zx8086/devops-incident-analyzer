// agent/src/iac/graph.ts
import { createCheckpointer } from "@devops-agent/checkpointer";
import { END, START, StateGraph } from "@langchain/langgraph";
import { initializeLangSmith } from "../langsmith.ts";
import {
	answerInfo,
	bootstrapIac,
	classifyIacIntent,
	draftChange,
	guardNode,
	openMr,
	parseIntent,
	planReviewGate,
	readClusterState,
	reviewPlan,
	teardownIac,
	watchPipeline,
} from "./nodes.ts";
import { IacState } from "./state.ts";

// Dedicated Elastic Cloud IaC maker graph. Every mutating/external step is gated;
// the planReview node is a human interrupt and the graph never applies (a human
// merges + applies from GitLab). Separate from the incident pipeline (buildGraph).
export async function buildIacGraph(config?: { checkpointerType?: "memory" | "sqlite" }) {
	await initializeLangSmith();

	const graph = new StateGraph(IacState)
		.addNode("bootstrap", bootstrapIac)
		.addNode("classifyIacIntent", classifyIacIntent)
		.addNode("answerInfo", answerInfo)
		.addNode("parseIntent", parseIntent)
		.addNode("readClusterState", readClusterState)
		.addNode("guard", guardNode)
		.addNode("draftChange", draftChange)
		.addNode("reviewPlan", reviewPlan)
		.addNode("reviewGate", planReviewGate)
		.addNode("openMr", openMr)
		.addNode("watchPipeline", watchPipeline)
		.addNode("teardown", teardownIac)

		.addEdge(START, "bootstrap")
		// Not connected -> surface the message and stop.
		.addConditionalEdges("bootstrap", (s) => (s.connected ? "classifyIacIntent" : END), ["classifyIacIntent", END])
		// SIO-870 info -> answerInfo; gitops -> maker pipeline. SIO-875 pipeline-status ->
		// re-check the thread's MR via watchPipeline (only set when an MR already exists).
		.addConditionalEdges(
			"classifyIacIntent",
			(s) => (s.intent === "gitops" ? "parseIntent" : s.intent === "pipeline-status" ? "watchPipeline" : "answerInfo"),
			["parseIntent", "answerInfo", "watchPipeline"],
		)
		.addEdge("answerInfo", END)
		.addEdge("parseIntent", "readClusterState")
		.addEdge("readClusterState", "guard")
		// Blocked by a mechanical safety guard -> stop before any write.
		.addConditionalEdges("guard", (s) => (s.blockedReason ? END : "draftChange"), ["draftChange", END])
		// SIO-873: the GitOps proposer (draftChange) can block too (e.g. missing token,
		// unparseable JSON) -> stop before the review gate.
		.addConditionalEdges("draftChange", (s) => (s.blockedReason ? END : "reviewPlan"), ["reviewPlan", END])
		.addEdge("reviewPlan", "reviewGate")
		// Human decision from the planReview interrupt routes to MR-open or stop.
		.addConditionalEdges("reviewGate", (s) => (s.reviewDecision === "approved" ? "openMr" : "teardown"), [
			"openMr",
			"teardown",
		])
		// SIO-875: after opening the MR, watch the pipeline (bounded) then render.
		.addEdge("openMr", "watchPipeline")
		.addEdge("watchPipeline", "teardown")
		.addEdge("teardown", END);

	const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
	return graph.compile({ checkpointer });
}
