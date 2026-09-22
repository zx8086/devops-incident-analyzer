// packages/agent/src/landing-zone/graph.ts

import { createCheckpointer } from "@devops-agent/checkpointer";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { LandingZoneEvidenceCollectors } from "./evidence.ts";
import {
	answerLandingZoneQuestion,
	assessLandingZoneRisk,
	bootstrapLandingZone,
	classifyLandingZoneRequest,
	createLandingZoneEvidenceNode,
	joinLandingZoneEvidence,
	recallLandingZoneMemory,
	reconcileLandingZoneEvidence,
	resolveLandingZoneScope,
	selectPvhKnowledge,
	teardownLandingZone,
} from "./nodes.ts";
import { LandingZoneState } from "./state.ts";

export interface BuildLandingZoneGraphOptions {
	checkpointerType?: "memory" | "sqlite";
	collectors?: LandingZoneEvidenceCollectors;
	awsLiveStateAuthorized?: boolean;
}

export async function buildLandingZoneGraph(options: BuildLandingZoneGraphOptions = {}) {
	const evidenceOptions = {
		collectors: options.collectors,
		awsLiveStateAuthorized: options.awsLiveStateAuthorized,
	};
	const collectorNodes = [
		"collectGitLabEvidence",
		"collectOkfEvidence",
		"collectTerraformDocsEvidence",
		"collectAwsDocsEvidence",
		"collectAwsApiEvidence",
		"collectMemoryEvidence",
		"collectKnowledgeGraphEvidence",
	] as const;
	const graph = new StateGraph(LandingZoneState)
		.addNode("bootstrap", bootstrapLandingZone)
		.addNode("classifyRequest", classifyLandingZoneRequest)
		.addNode("resolveScope", resolveLandingZoneScope)
		.addNode("recallMemory", recallLandingZoneMemory)
		.addNode("selectPvhKnowledge", selectPvhKnowledge)
		.addNode("collectGitLabEvidence", createLandingZoneEvidenceNode("gitlab", evidenceOptions))
		.addNode("collectOkfEvidence", createLandingZoneEvidenceNode("pvh-okf", evidenceOptions))
		.addNode("collectTerraformDocsEvidence", createLandingZoneEvidenceNode("terraform-docs", evidenceOptions))
		.addNode("collectAwsDocsEvidence", createLandingZoneEvidenceNode("aws-docs", evidenceOptions))
		.addNode("collectAwsApiEvidence", createLandingZoneEvidenceNode("aws-api", evidenceOptions))
		.addNode("collectMemoryEvidence", createLandingZoneEvidenceNode("memory", evidenceOptions))
		.addNode("collectKnowledgeGraphEvidence", createLandingZoneEvidenceNode("knowledge-graph", evidenceOptions))
		.addNode("joinEvidence", joinLandingZoneEvidence)
		.addNode("reconcileEvidence", reconcileLandingZoneEvidence)
		.addNode("assessRisk", assessLandingZoneRisk)
		.addNode("answerQuestion", answerLandingZoneQuestion)
		.addNode("teardown", teardownLandingZone)
		.addEdge(START, "bootstrap")
		.addEdge("bootstrap", "classifyRequest")
		.addEdge("classifyRequest", "resolveScope")
		.addEdge("resolveScope", "recallMemory")
		.addEdge("recallMemory", "selectPvhKnowledge")
		.addEdge("joinEvidence", "reconcileEvidence")
		.addEdge("reconcileEvidence", "assessRisk")
		.addEdge("assessRisk", "answerQuestion")
		.addEdge("answerQuestion", "teardown")
		.addEdge("teardown", END);
	for (const collectorNode of collectorNodes) graph.addEdge("selectPvhKnowledge", collectorNode);
	graph.addEdge([...collectorNodes], "joinEvidence");

	return graph.compile({ checkpointer: createCheckpointer(options.checkpointerType ?? "memory") });
}
