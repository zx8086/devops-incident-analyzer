// agent/src/graph.ts

import { createCheckpointer } from "@devops-agent/checkpointer";
import { getLogger, traceSpan } from "@devops-agent/observability";
import type { RunnableConfig } from "@langchain/core/runnables";
import { END, StateGraph } from "@langchain/langgraph";
import { aggregate } from "./aggregator.ts";
import { checkAlignment, routeAfterAlignment } from "./alignment.ts";
import { classify } from "./classifier.ts";
import { checkConfidence } from "./confidence-gate.ts";
import { extractEntities } from "./entity-extractor.ts";
import { generateSuggestions } from "./follow-up-generator.ts";
import { initializeLangSmith } from "./langsmith.ts";
import { proposeMitigation } from "./mitigation.ts";
import { normalizeIncident } from "./normalizer.ts";
import { getAgent } from "./prompt-context.ts";
import { respond } from "./responder.ts";
import { createSelectRunbooksNode } from "./runbook-selector.ts";
import { AgentState, type AgentStateType } from "./state.ts";
import { queryDataSource } from "./sub-agent.ts";
import { supervise } from "./supervisor.ts";
import { shouldRetryValidation, validate } from "./validator.ts";

const graphLogger = getLogger("agent:graph");

type NodeFn = (
	state: AgentStateType,
	config?: RunnableConfig,
) => Partial<AgentStateType> | Promise<Partial<AgentStateType>>;

function traceNode(
	name: string,
	fn: NodeFn,
): (state: AgentStateType, config: RunnableConfig) => Promise<Partial<AgentStateType>> {
	return (state: AgentStateType, config: RunnableConfig) =>
		traceSpan("agent", `agent.node.${name}`, async () => fn(state, config), {
			"agent.node.name": name,
			...(state.requestId && { "request.id": state.requestId }),
			...(state.currentDataSource && { data_source_id: state.currentDataSource }),
		});
}

export async function buildGraph(config?: { checkpointerType?: "memory" | "sqlite" }) {
	await initializeLangSmith();

	// SIO-640: opt-in gate. When the loaded agent has a runbook_selection
	// block in knowledge/index.yaml, wire normalize -> selectRunbooks ->
	// entityExtractor. Otherwise keep the normalize -> entityExtractor edge
	// and the selector is wired but never reached.
	//
	// Note: the selectRunbooks node is always registered in the graph type so
	// LangGraph's static type inference knows about it. The runtime gate is
	// the edge: when disabled, no edge points at selectRunbooks so it's
	// unreachable from the START node.
	const agent = getAgent();
	const runbookSelectorEnabled = agent.runbookSelection !== undefined;
	graphLogger.info(
		{ runbookSelectorEnabled },
		runbookSelectorEnabled
			? "Runbook selector node enabled (runbook_selection config present)"
			: "Runbook selector node disabled (no runbook_selection config)",
	);

	const graph = new StateGraph(AgentState)
		.addNode("classify", traceNode("classify", classify))
		.addNode("normalize", traceNode("normalize", normalizeIncident))
		.addNode("responder", traceNode("responder", respond))
		.addNode("entityExtractor", traceNode("entityExtractor", extractEntities))
		.addNode("queryDataSource", traceNode("queryDataSource", queryDataSource))
		.addNode("align", traceNode("align", checkAlignment))
		.addNode("aggregate", traceNode("aggregate", aggregate))
		.addNode("checkConfidence", traceNode("checkConfidence", checkConfidence))
		.addNode("validate", traceNode("validate", validate))
		.addNode("proposeMitigation", traceNode("proposeMitigation", proposeMitigation))
		.addNode("followUp", traceNode("followUp", generateSuggestions))
		.addNode("selectRunbooks", traceNode("selectRunbooks", createSelectRunbooksNode()))

		// Entry
		.addEdge("__start__", "classify")

		// SIO-630: Classify -> normalize (complex) or responder (simple)
		.addConditionalEdges("classify", (state) => {
			return state.queryComplexity === "simple" ? "responder" : "normalize";
		})

		// Simple path: responder -> followUp -> END
		.addEdge("responder", "followUp")
		.addEdge("followUp", END)

		// SIO-640: normalize -> [selectRunbooks ->] entityExtractor
		.addEdge("normalize", runbookSelectorEnabled ? "selectRunbooks" : "entityExtractor")
		.addEdge("selectRunbooks", "entityExtractor")

		// EntityExtractor fans out to sub-agents via Send[]
		.addConditionalEdges("entityExtractor", supervise)

		// Sub-agent results flow to alignment
		.addEdge("queryDataSource", "align")

		// Alignment -> Send[] retries or aggregate
		.addConditionalEdges("align", routeAfterAlignment, ["queryDataSource", "aggregate"])

		// SIO-632: Aggregate -> checkConfidence (HITL gate) -> validate
		.addEdge("aggregate", "checkConfidence")
		.addEdge("checkConfidence", "validate")

		// SIO-631: Validate -> retry aggregate or proposeMitigation -> followUp -> END
		.addConditionalEdges("validate", (state) => {
			return shouldRetryValidation(state) ? "aggregate" : "proposeMitigation";
		})
		.addEdge("proposeMitigation", "followUp");

	const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
	return graph.compile({ checkpointer });
}
