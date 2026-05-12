// agent/src/graph.ts

import { createCheckpointer } from "@devops-agent/checkpointer";
import { getLogger, traceSpan } from "@devops-agent/observability";
import type { RunnableConfig } from "@langchain/core/runnables";
import { END, Send, StateGraph } from "@langchain/langgraph";
import { aggregate } from "./aggregator.ts";
import { checkAlignment, routeAfterAlignment } from "./alignment.ts";
import { classify } from "./classifier.ts";
import { checkConfidence } from "./confidence-gate.ts";
import {
	correlationFetch,
	enforceCorrelationsAggregate,
	enforceCorrelationsRouter,
} from "./correlation/enforce-node.ts";
import { extractEntities } from "./entity-extractor.ts";
import { generateSuggestions } from "./follow-up-generator.ts";
import { initializeLangSmith } from "./langsmith.ts";
import { aggregateMitigation } from "./mitigation.ts";
import { proposeEscalate, proposeInvestigate, proposeMonitor } from "./mitigation-branches.ts";
import { normalizeIncident } from "./normalizer.ts";
import { getAgent } from "./prompt-context.ts";
import { respond } from "./responder.ts";
import { createSelectRunbooksNode } from "./runbook-selector.ts";
import { AgentState, type AgentStateType } from "./state.ts";
import { queryDataSource } from "./sub-agent.ts";
import { supervise } from "./supervisor.ts";
import { shouldRetryValidation, validate } from "./validator.ts";

const graphLogger = getLogger("agent:graph");

// SIO-741: validate -> retry-aggregate OR three parallel mitigation branches.
// Exported so the dispatcher can be unit-tested without booting the whole graph.
export function routeAfterValidate(state: AgentStateType): "aggregate" | Send[] {
	if (shouldRetryValidation(state)) return "aggregate";
	return [new Send("proposeInvestigate", state), new Send("proposeMonitor", state), new Send("proposeEscalate", state)];
}

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
		.addNode("correlationFetch", traceNode("correlationFetch", correlationFetch))
		.addNode("enforceCorrelationsAggregate", traceNode("enforceCorrelationsAggregate", enforceCorrelationsAggregate))
		.addNode("checkConfidence", traceNode("checkConfidence", checkConfidence))
		.addNode("validate", traceNode("validate", validate))
		.addNode("proposeInvestigate", traceNode("proposeInvestigate", proposeInvestigate))
		.addNode("proposeMonitor", traceNode("proposeMonitor", proposeMonitor))
		.addNode("proposeEscalate", traceNode("proposeEscalate", proposeEscalate))
		.addNode("aggregateMitigation", traceNode("aggregateMitigation", aggregateMitigation))
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

		// SIO-681: Aggregate -> enforceCorrelations router (re-fan-out via correlationFetch when rules fire,
		// otherwise straight to enforceCorrelationsAggregate which is a no-op pass-through)
		.addConditionalEdges("aggregate", enforceCorrelationsRouter, ["correlationFetch", "enforceCorrelationsAggregate"])
		.addEdge("correlationFetch", "enforceCorrelationsAggregate")
		.addEdge("enforceCorrelationsAggregate", "checkConfidence")
		.addEdge("checkConfidence", "validate")

		// SIO-631 + SIO-741: Validate -> retry aggregate OR fan out to three parallel
		// mitigation branches that join at aggregateMitigation. The branches share the
		// validated state; the aggregator merges their fragments + selectedRunbooks
		// into mitigationSteps and then runs the sequential action-proposal step.
		.addConditionalEdges("validate", routeAfterValidate, [
			"aggregate",
			"proposeInvestigate",
			"proposeMonitor",
			"proposeEscalate",
		])
		.addEdge("proposeInvestigate", "aggregateMitigation")
		.addEdge("proposeMonitor", "aggregateMitigation")
		.addEdge("proposeEscalate", "aggregateMitigation")
		.addEdge("aggregateMitigation", "followUp");

	const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
	return graph.compile({ checkpointer });
}
