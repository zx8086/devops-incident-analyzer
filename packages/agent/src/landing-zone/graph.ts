// packages/agent/src/landing-zone/graph.ts

import { createCheckpointer } from "@devops-agent/checkpointer";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { LandingZoneAnswerGenerator } from "./answer.ts";
import { createLandingZoneChangeNodes, type LandingZoneChangeTools } from "./change-nodes.ts";
import type { LandingZoneEvidenceCollectors } from "./evidence.ts";
import {
	answerLandingZoneQuestion,
	assessLandingZoneRisk,
	bootstrapLandingZone,
	classifyLandingZoneRequest,
	createLandingZoneEvidenceNode,
	createSynthesizeLandingZoneAnswerNode,
	degradeLandingZoneAnswer,
	gateLandingZoneScope,
	joinLandingZoneEvidence,
	publishLandingZoneAnswer,
	recallLandingZoneMemory,
	reconcileLandingZoneEvidence,
	resolveLandingZoneScope,
	selectPvhKnowledge,
	teardownLandingZone,
	validateLandingZoneAnswerNode,
} from "./nodes.ts";
import { LandingZoneState } from "./state.ts";
import { type LandingZoneTopologyTool, projectLandingZoneTopologyNode } from "./topology-node.ts";

export interface BuildLandingZoneGraphOptions {
	checkpointerType?: "memory" | "sqlite";
	collectors?: LandingZoneEvidenceCollectors;
	awsLiveStateAuthorized?: boolean;
	topologyTools?: LandingZoneTopologyTool[];
	changeTools?: LandingZoneChangeTools;
	answerGenerator?: LandingZoneAnswerGenerator;
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
	const changeNodes = createLandingZoneChangeNodes(options.changeTools);
	const graph = new StateGraph(LandingZoneState)
		.addNode("bootstrap", bootstrapLandingZone)
		.addNode("classifyRequest", classifyLandingZoneRequest)
		.addNode("resolveScope", resolveLandingZoneScope)
		.addNode("scopeGate", gateLandingZoneScope)
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
		.addNode("synthesizeAnswer", createSynthesizeLandingZoneAnswerNode(options.answerGenerator))
		.addNode("validateAnswer", validateLandingZoneAnswerNode)
		.addNode("degradedAnswer", degradeLandingZoneAnswer)
		.addNode("publishAnswer", publishLandingZoneAnswer)
		.addNode("draftChange", changeNodes.draftChange)
		.addNode("validateCandidate", changeNodes.validateCandidate)
		.addNode("prepareReview", changeNodes.prepareReview)
		.addNode("reviewGate", changeNodes.reviewGate)
		.addNode("openMergeRequest", changeNodes.openMergeRequest)
		.addNode("watchPipeline", changeNodes.watchPipeline)
		.addNode("recordOutcome", changeNodes.recordOutcome)
		.addNode("projectTopology", (state) => projectLandingZoneTopologyNode(state, { tools: options.topologyTools }))
		.addNode("teardown", teardownLandingZone)
		.addEdge(START, "bootstrap")
		.addEdge("bootstrap", "classifyRequest")
		.addEdge("classifyRequest", "resolveScope")
		.addEdge("resolveScope", "scopeGate")
		.addConditionalEdges("scopeGate", (state) => (state.blockedReason ? "answerQuestion" : "recallMemory"), [
			"answerQuestion",
			"recallMemory",
		])
		.addEdge("recallMemory", "selectPvhKnowledge")
		.addEdge("joinEvidence", "reconcileEvidence")
		.addEdge("reconcileEvidence", "assessRisk")
		.addConditionalEdges(
			"assessRisk",
			(state) =>
				state.intent === "propose-change" && !state.risk?.blocked && !state.blockedReason
					? "draftChange"
					: state.risk?.blocked || state.blockedReason
						? "answerQuestion"
						: "synthesizeAnswer",
			["draftChange", "answerQuestion", "synthesizeAnswer"],
		)
		.addEdge("synthesizeAnswer", "validateAnswer")
		.addConditionalEdges(
			"validateAnswer",
			(state) =>
				state.answerValidation?.valid
					? "publishAnswer"
					: state.answerRetryCount < 2
						? "synthesizeAnswer"
						: "degradedAnswer",
			["publishAnswer", "synthesizeAnswer", "degradedAnswer"],
		)
		.addEdge("degradedAnswer", "publishAnswer")
		.addConditionalEdges("draftChange", (state) => (state.blockedReason ? "answerQuestion" : "validateCandidate"), [
			"validateCandidate",
			"answerQuestion",
		])
		.addConditionalEdges(
			"validateCandidate",
			(state) => (state.blockedReason || !state.candidateValidationPassed ? "answerQuestion" : "prepareReview"),
			["prepareReview", "answerQuestion"],
		)
		.addConditionalEdges("prepareReview", (state) => (state.blockedReason ? "answerQuestion" : "reviewGate"), [
			"reviewGate",
			"answerQuestion",
		])
		.addConditionalEdges(
			"reviewGate",
			(state) =>
				state.reviewDecision?.decision === "approve"
					? "openMergeRequest"
					: state.reviewDecision?.decision === "amend"
						? "draftChange"
						: "recordOutcome",
			["openMergeRequest", "draftChange", "recordOutcome"],
		)
		.addConditionalEdges("openMergeRequest", (state) => (state.mergeRequest ? "watchPipeline" : "recordOutcome"), [
			"watchPipeline",
			"recordOutcome",
		])
		.addEdge("watchPipeline", "recordOutcome")
		.addEdge("recordOutcome", "teardown")
		.addEdge("answerQuestion", "projectTopology")
		.addEdge("publishAnswer", "projectTopology")
		.addEdge("projectTopology", "teardown")
		.addEdge("teardown", END);
	for (const collectorNode of collectorNodes) graph.addEdge("selectPvhKnowledge", collectorNode);
	graph.addEdge([...collectorNodes], "joinEvidence");

	return graph.compile({ checkpointer: createCheckpointer(options.checkpointerType ?? "memory") });
}
