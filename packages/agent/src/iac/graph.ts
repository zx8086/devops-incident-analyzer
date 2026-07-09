// agent/src/iac/graph.ts
import { createCheckpointer } from "@devops-agent/checkpointer";
import { isKnowledgeGraphEnabled } from "@devops-agent/knowledge-graph";
import { END, START, StateGraph } from "@langchain/langgraph";
import { initializeLangSmith } from "../langsmith.ts";
import { selectedBackend } from "../memory-backend.ts";
import {
	graphEnrichIac,
	memoryEnrichIac,
	recordIacEntities,
	recordIacOutcome,
	recordIacPromptNode,
} from "./graph-knowledge.ts";
import {
	advanceDrift,
	amendChange,
	answerInfo,
	applyFleetUpgrade,
	bootstrapIac,
	classifyIacIntent,
	converseIac,
	detectDrift,
	detectFleetUpgrade,
	detectSyntheticsDrift,
	draftChange,
	explainDrift,
	fleetUpgradeGate,
	guardNode,
	hasApplicableFleetUpgrade,
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

	// SIO-954: knowledge-graph nodes. Registered always (type-safe); reached only when
	// KNOWLEDGE_GRAPH_ENABLED is set -- the SIO-850/SIO-640 edge-gate idiom. graphEnrichIac
	// reads the deployment's recent change history before drafting (spliced into
	// readClusterState -> guard); recordIacEntities writes this turn's change after the MR is
	// opened (spliced into openMr -> watchPipeline). The splice is done with a build-time-constant
	// conditional edge whose `ends` list always names the KG node (keeping it reachable for
	// compilation) but whose router only selects it when the flag is on.
	const knowledgeGraphEnabled = isKnowledgeGraphEnabled();
	// SIO-970: agent-memory recall is an INDEPENDENT enrich, gated on its own backend (not the
	// KG flag). memoryEnrichIac is spliced after the optional graphEnrichIac and before guard so
	// the two enrichments compose; both gates are build-time constants and always name the node
	// in their `ends` list (keeps it reachable for compilation) -- the SIO-640 edge-gate idiom.
	const memoryEnrichEnabled = selectedBackend() === "agent-memory";
	const enrichTarget = () => (knowledgeGraphEnabled ? "graphEnrichIac" : memoryTarget());
	const memoryTarget = () => (memoryEnrichEnabled ? "memoryEnrichIac" : "guard");
	const recordTarget = () => (knowledgeGraphEnabled ? "recordIacEntities" : "watchPipeline");
	// SIO-1038: prompt-capture runs before the intent fan-out so EVERY turn is covered.
	// Selected when EITHER sink is enabled (KG flag OR agent-memory backend); each sink
	// re-checks its own gate inside the node. Same edge-gate idiom -- the node is always
	// registered and always named in the `ends` list.
	const promptTarget = () => (knowledgeGraphEnabled || memoryEnrichEnabled ? "recordIacPrompt" : "classifyIacIntent");
	// SIO-965: recordIacOutcome (Pipeline + terminal ConfigChange.outcome) runs after
	// watchPipeline when the KG is enabled, for both the gitops MR flow and the
	// pipeline-status re-check. Same edge-gate idiom as the SIO-954 nodes above.
	const outcomeTarget = () => (knowledgeGraphEnabled ? "recordIacOutcome" : "teardown");

	const graph = new StateGraph(IacState)
		.addNode("bootstrap", bootstrapIac)
		.addNode("classifyIacIntent", classifyIacIntent)
		.addNode("answerInfo", answerInfo)
		.addNode("converseIac", converseIac)
		.addNode("parseIntent", parseIntent)
		// SIO-990: amend lane -- a correction to the change proposed this session re-parses + re-commits
		// onto the same branch (updating the existing MR in place) instead of proposing from scratch.
		.addNode("amendChange", amendChange)
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
		// SIO-913: Fleet agent binary-upgrade sub-flow. detectFleetUpgrade triggers a preview
		// pipeline (resolve count + upgradeable crosstab) and emits the report; fleetUpgradeGate
		// holds the single operator approve/decline interrupt; applyFleetUpgrade triggers the
		// bulk_upgrade apply pipeline + verify sweep.
		.addNode("detectFleetUpgrade", detectFleetUpgrade)
		.addNode("fleetUpgradeGate", fleetUpgradeGate)
		.addNode("applyFleetUpgrade", applyFleetUpgrade)
		// SIO-954: KG read/write nodes (registered always; reached only when enabled).
		.addNode("graphEnrichIac", graphEnrichIac)
		// SIO-970: agent-memory recall node (registered always; reached only when the
		// agent-memory backend is selected, independent of the KG flag).
		.addNode("memoryEnrichIac", memoryEnrichIac)
		// SIO-1038: prompt-capture node (registered always; reached only when the KG or the
		// agent-memory backend is enabled). Writes the verbatim prompt to both sinks.
		.addNode("recordIacPrompt", recordIacPromptNode)
		.addNode("recordIacEntities", recordIacEntities)
		// SIO-965: KG outcome node (Pipeline + terminal outcome), registered always.
		.addNode("recordIacOutcome", recordIacOutcome)
		.addNode("teardown", teardownIac)

		.addEdge(START, "bootstrap")
		// Not connected -> surface the message and stop. SIO-1038: when connected, detour
		// through recordIacPrompt first (if a sink is enabled) so every turn's prompt is
		// captured before the intent fan-out; the node then advances to classifyIacIntent.
		.addConditionalEdges("bootstrap", (s) => (s.connected ? promptTarget() : END), [
			"recordIacPrompt",
			"classifyIacIntent",
			END,
		])
		.addEdge("recordIacPrompt", "classifyIacIntent")
		// SIO-870 info -> answerInfo; gitops -> maker pipeline. SIO-875 pipeline-status ->
		// re-check the thread's MR via watchPipeline. SIO-882 drift -> detectDrift.
		.addConditionalEdges(
			"classifyIacIntent",
			(s) =>
				s.intent === "gitops"
					? "parseIntent"
					: s.intent === "gitops-amend"
						? "amendChange"
						: s.intent === "fleet-upgrade"
							? "detectFleetUpgrade"
							: s.intent === "synthetics-drift"
								? "detectSyntheticsDrift"
								: s.intent === "drift"
									? "detectDrift"
									: s.intent === "pipeline-status"
										? "watchPipeline"
										: s.intent === "converse"
											? "converseIac"
											: "answerInfo",
			[
				"parseIntent",
				"amendChange",
				"detectFleetUpgrade",
				"detectSyntheticsDrift",
				"detectDrift",
				"answerInfo",
				"watchPipeline",
				"converseIac",
			],
		)
		.addEdge("answerInfo", END)
		.addEdge("converseIac", END)
		// SIO-912: parseIntent short-circuits a request it has no proposer for (workflow
		// "other") with a capability message + blockedReason -> stop before reading cluster
		// state or drafting. Otherwise proceed to the maker pipeline.
		.addConditionalEdges("parseIntent", (s) => (s.blockedReason || s.noopReason ? END : "readClusterState"), [
			"readClusterState",
			END,
		])
		// SIO-990: amendChange re-parses (via parseIntent); same blockedReason short-circuit, then the
		// shared maker chain (readClusterState -> guard -> draftChange -> reviewPlan -> reviewGate).
		// SIO-1020: a no-op (noopReason) is terminal too -- it ends the turn without opening an MR.
		.addConditionalEdges("amendChange", (s) => (s.blockedReason || s.noopReason ? END : "readClusterState"), [
			"readClusterState",
			END,
		])
		// SIO-954/SIO-970: readClusterState -> guard, with graphEnrichIac (KG) and memoryEnrichIac
		// (agent-memory recall) spliced in before guard when their respective backends are enabled.
		// Each enrich routes onward via memoryTarget so the two compose independently.
		.addConditionalEdges("readClusterState", enrichTarget, ["graphEnrichIac", "memoryEnrichIac", "guard"])
		.addConditionalEdges("graphEnrichIac", memoryTarget, ["memoryEnrichIac", "guard"])
		.addEdge("memoryEnrichIac", "guard")
		// Blocked by a mechanical safety guard -> stop before any write.
		.addConditionalEdges("guard", (s) => (s.blockedReason ? END : "draftChange"), ["draftChange", END])
		// SIO-873: the GitOps proposer (draftChange) can block too (e.g. missing token,
		// unparseable JSON) -> stop before the review gate. SIO-1020: a no-op (noopReason -- the
		// requested config already matches current state) is also terminal here; the turn ends with a
		// neutral "No change needed" outcome instead of opening an empty-diff MR.
		.addConditionalEdges("draftChange", (s) => (s.blockedReason || s.noopReason ? END : "reviewPlan"), [
			"reviewPlan",
			END,
		])
		.addEdge("reviewPlan", "reviewGate")
		// Human decision from the planReview interrupt routes to MR-open or stop.
		// SIO-990: on an APPROVED amend that already has an open MR, the corrected commit landed on the
		// existing branch (resolveBranch pinned it) so the MR is already updated -- skip the duplicate
		// openMr (GitLab 409s on a second MR for the same source branch) and go straight to watching
		// the (now re-triggered) pipeline. A first-time gitops approval still opens the MR.
		.addConditionalEdges(
			"reviewGate",
			(s) => {
				if (s.reviewDecision !== "approved") return "teardown";
				return s.intent === "gitops-amend" && s.activeChange?.mrIid != null ? "watchPipeline" : "openMr";
			},
			["openMr", "watchPipeline", "teardown"],
		)
		// SIO-875: after opening the MR, watch the pipeline (bounded) then render.
		// SIO-954: openMr -> watchPipeline, with recordIacEntities spliced in when the KG is enabled.
		.addConditionalEdges("openMr", recordTarget, ["recordIacEntities", "watchPipeline"])
		.addEdge("recordIacEntities", "watchPipeline")
		// SIO-965: watchPipeline -> teardown, with recordIacOutcome spliced in when the KG is enabled.
		.addConditionalEdges("watchPipeline", outcomeTarget, ["recordIacOutcome", "teardown"])
		.addEdge("recordIacOutcome", "teardown")
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
		// SIO-913: fleet-upgrade straight line. No applicable upgrade (planError / version
		// unavailable / nothing upgradeable) -> teardown (the summary leads with the reason);
		// >=1 upgradeable agent -> the apply gate.
		.addConditionalEdges(
			"detectFleetUpgrade",
			(s) => (hasApplicableFleetUpgrade(s.fleetUpgradeReport) ? "fleetUpgradeGate" : "teardown"),
			["fleetUpgradeGate", "teardown"],
		)
		// Operator approval routes to the apply or to teardown (declined).
		.addConditionalEdges("fleetUpgradeGate", (s) => (s.fleetUpgradeApproved ? "applyFleetUpgrade" : "teardown"), [
			"applyFleetUpgrade",
			"teardown",
		])
		.addEdge("applyFleetUpgrade", "teardown")
		.addEdge("teardown", END);

	const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
	return graph.compile({ checkpointer });
}
