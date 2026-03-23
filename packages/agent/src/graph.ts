// agent/src/graph.ts

import { createCheckpointer } from "@devops-agent/checkpointer";
import { traceSpan } from "@devops-agent/observability";
import { END, StateGraph } from "@langchain/langgraph";
import { aggregate } from "./aggregator.ts";
import { checkAlignment, routeAfterAlignment } from "./alignment.ts";
import { classify } from "./classifier.ts";
import { extractEntities } from "./entity-extractor.ts";
import { initializeLangSmith } from "./langsmith.ts";
import { respond } from "./responder.ts";
import { AgentState, type AgentStateType } from "./state.ts";
import { queryDataSource } from "./sub-agent.ts";
import { supervise } from "./supervisor.ts";
import { shouldRetryValidation, validate } from "./validator.ts";

type NodeFn = (state: AgentStateType) => Partial<AgentStateType> | Promise<Partial<AgentStateType>>;

function traceNode(name: string, fn: NodeFn): (state: AgentStateType) => Promise<Partial<AgentStateType>> {
	return (state: AgentStateType) =>
		traceSpan("agent", `agent.node.${name}`, async () => fn(state), {
			"agent.node.name": name,
			...(state.requestId && { "request.id": state.requestId }),
			...(state.currentDataSource && { "data_source_id": state.currentDataSource }),
		});
}

export function buildGraph(config?: { checkpointerType?: "memory" | "sqlite" }) {
	initializeLangSmith();
	const graph = new StateGraph(AgentState)
		.addNode("classify", traceNode("classify", classify))
		.addNode("responder", traceNode("responder", respond))
		.addNode("entityExtractor", traceNode("entityExtractor", extractEntities))
		.addNode("queryDataSource", traceNode("queryDataSource", queryDataSource))
		.addNode("align", traceNode("align", checkAlignment))
		.addNode("aggregate", traceNode("aggregate", aggregate))
		.addNode("validate", traceNode("validate", validate))

		// Entry
		.addEdge("__start__", "classify")

		// Classify -> responder (simple) or entityExtractor (complex)
		.addConditionalEdges("classify", (state) => {
			return state.queryComplexity === "simple" ? "responder" : "entityExtractor";
		})

		// Simple path ends
		.addEdge("responder", END)

		// EntityExtractor fans out to sub-agents via Send[]
		.addConditionalEdges("entityExtractor", supervise)

		// Sub-agent results flow to alignment
		.addEdge("queryDataSource", "align")

		// Alignment -> Send[] retries or aggregate
		.addConditionalEdges("align", routeAfterAlignment, ["queryDataSource", "aggregate"])

		// Aggregate -> validate
		.addEdge("aggregate", "validate")

		// Validate -> END or retry aggregate
		.addConditionalEdges("validate", (state) => {
			return shouldRetryValidation(state) ? "aggregate" : "__end__";
		});

	const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
	return graph.compile({ checkpointer });
}
