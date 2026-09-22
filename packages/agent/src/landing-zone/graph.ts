// packages/agent/src/landing-zone/graph.ts

import { createCheckpointer } from "@devops-agent/checkpointer";
import { END, START, StateGraph } from "@langchain/langgraph";
import {
	answerLandingZoneQuestion,
	assessLandingZoneRisk,
	bootstrapLandingZone,
	classifyLandingZoneRequest,
	gatherLandingZoneEvidence,
	reconcileLandingZoneEvidence,
	resolveLandingZoneScope,
	selectPvhKnowledge,
	teardownLandingZone,
} from "./nodes.ts";
import { LandingZoneState } from "./state.ts";

export interface BuildLandingZoneGraphOptions {
	checkpointerType?: "memory" | "sqlite";
}

export async function buildLandingZoneGraph(options: BuildLandingZoneGraphOptions = {}) {
	const graph = new StateGraph(LandingZoneState)
		.addNode("bootstrap", bootstrapLandingZone)
		.addNode("classifyRequest", classifyLandingZoneRequest)
		.addNode("resolveScope", resolveLandingZoneScope)
		.addNode("selectPvhKnowledge", selectPvhKnowledge)
		.addNode("gatherEvidence", gatherLandingZoneEvidence)
		.addNode("reconcileEvidence", reconcileLandingZoneEvidence)
		.addNode("assessRisk", assessLandingZoneRisk)
		.addNode("answerQuestion", answerLandingZoneQuestion)
		.addNode("teardown", teardownLandingZone)
		.addEdge(START, "bootstrap")
		.addEdge("bootstrap", "classifyRequest")
		.addEdge("classifyRequest", "resolveScope")
		.addEdge("resolveScope", "selectPvhKnowledge")
		.addEdge("selectPvhKnowledge", "gatherEvidence")
		.addEdge("gatherEvidence", "reconcileEvidence")
		.addEdge("reconcileEvidence", "assessRisk")
		.addEdge("assessRisk", "answerQuestion")
		.addEdge("answerQuestion", "teardown")
		.addEdge("teardown", END);

	return graph.compile({ checkpointer: createCheckpointer(options.checkpointerType ?? "memory") });
}
