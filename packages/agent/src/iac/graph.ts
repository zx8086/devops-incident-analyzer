// agent/src/iac/graph.ts
import { createCheckpointer } from "@devops-agent/checkpointer";
import { END, START, StateGraph } from "@langchain/langgraph";
import { initializeLangSmith } from "../langsmith.ts";
import {
	advanceDrift,
	answerInfo,
	bootstrapIac,
	classifyIacIntent,
	detectDrift,
	detectSyntheticsDrift,
	draftChange,
	explainDrift,
	guardNode,
	hasPushableSyntheticsDrift,
	openMr,
	parseIntent,
	planReviewGate,
	pushSynthetics,
	readClusterState,
	reconcileGate,
	reconcileStack,
	reviewPlan,
	syntheticsPushGate,
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
		// SIO-882: drift reconcile sub-flow. detectDrift audits all stacks; SIO-886
		// explainDrift attaches a grounded per-stack explanation + emits the report; the
		// reconcileGate -> reconcileStack -> advanceDrift loop processes drifted stacks
		// one at a time (reconcileGate holds the single interrupt per stack).
		.addNode("detectDrift", detectDrift)
		.addNode("explainDrift", explainDrift)
		.addNode("reconcileGate", reconcileGate)
		.addNode("reconcileStack", reconcileStack)
		.addNode("advanceDrift", advanceDrift)
		// SIO-902: synthetics drift sub-flow. detectSyntheticsDrift audits one deployment's
		// monitors (source YAML vs live Kibana) and emits the report; syntheticsPushGate holds
		// the single operator approve/decline interrupt; pushSynthetics triggers the remote push.
		.addNode("detectSyntheticsDrift", detectSyntheticsDrift)
		.addNode("syntheticsPushGate", syntheticsPushGate)
		.addNode("pushSynthetics", pushSynthetics)
		.addNode("teardown", teardownIac)

		.addEdge(START, "bootstrap")
		// Not connected -> surface the message and stop.
		.addConditionalEdges("bootstrap", (s) => (s.connected ? "classifyIacIntent" : END), ["classifyIacIntent", END])
		// SIO-870 info -> answerInfo; gitops -> maker pipeline. SIO-875 pipeline-status ->
		// re-check the thread's MR via watchPipeline. SIO-882 drift -> detectDrift.
		.addConditionalEdges(
			"classifyIacIntent",
			(s) =>
				s.intent === "gitops"
					? "parseIntent"
					: s.intent === "synthetics-drift"
						? "detectSyntheticsDrift"
						: s.intent === "drift"
							? "detectDrift"
							: s.intent === "pipeline-status"
								? "watchPipeline"
								: "answerInfo",
			["parseIntent", "detectSyntheticsDrift", "detectDrift", "answerInfo", "watchPipeline"],
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
		// SIO-882: drift sub-flow. Early exit (no deployment/stacks) -> END (the message is
		// already set); otherwise explainDrift attaches explanations + emits the report.
		.addConditionalEdges("detectDrift", (s) => (s.driftReport ? "explainDrift" : END), ["explainDrift", END])
		// SIO-886: after explaining, no drift -> teardown ("no drift" summary); >=1 drifted ->
		// the per-stack reconcile loop.
		.addConditionalEdges(
			"explainDrift",
			(s) => (s.driftReport && s.driftReport.stacks.filter((x) => x.drifted).length > 0 ? "reconcileGate" : "teardown"),
			["reconcileGate", "teardown"],
		)
		// reconcileGate holds the per-stack interrupt; "skip" advances, any reconcile
		// direction opens an MR in reconcileStack.
		.addConditionalEdges("reconcileGate", (s) => (s.currentDirection === "skip" ? "advanceDrift" : "reconcileStack"), [
			"reconcileStack",
			"advanceDrift",
		])
		.addEdge("reconcileStack", "advanceDrift")
		// Loop back to the gate until every drifted stack is processed, then render the summary.
		.addConditionalEdges(
			"advanceDrift",
			(s) =>
				s.driftIndex < (s.driftReport?.stacks.filter((x) => x.drifted).length ?? 0) ? "reconcileGate" : "teardown",
			["reconcileGate", "teardown"],
		)
		// SIO-902: synthetics straight line. No report / planError / clean / extra-only ->
		// teardown (the summary leads with the right headline); pushable drift -> the push gate.
		.addConditionalEdges(
			"detectSyntheticsDrift",
			(s) => (hasPushableSyntheticsDrift(s.syntheticsDriftReport) ? "syntheticsPushGate" : "teardown"),
			["syntheticsPushGate", "teardown"],
		)
		// Operator approval routes to the push or to teardown (declined).
		.addConditionalEdges("syntheticsPushGate", (s) => (s.syntheticsPushApproved ? "pushSynthetics" : "teardown"), [
			"pushSynthetics",
			"teardown",
		])
		.addEdge("pushSynthetics", "teardown")
		.addEdge("teardown", END);

	const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
	return graph.compile({ checkpointer });
}
