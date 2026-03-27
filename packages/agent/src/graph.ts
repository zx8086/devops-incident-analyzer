// agent/src/graph.ts

import { createCheckpointer } from "@devops-agent/checkpointer";
import { traceSpan } from "@devops-agent/observability";
import type { RunnableConfig } from "@langchain/core/runnables";
import { END, StateGraph } from "@langchain/langgraph";
import { aggregate } from "./aggregator.ts";
import { checkAlignment, routeAfterAlignment } from "./alignment.ts";
import { classify } from "./classifier.ts";
import { extractEntities } from "./entity-extractor.ts";
import { generateSuggestions } from "./follow-up-generator.ts";
import { initializeLangSmith } from "./langsmith.ts";
import { respond } from "./responder.ts";
import { AgentState, type AgentStateType } from "./state.ts";
import { queryDataSource } from "./sub-agent.ts";
import { supervise } from "./supervisor.ts";
import { shouldRetryValidation, validate } from "./validator.ts";

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
	const graph = new StateGraph(AgentState)
		.addNode("classify", traceNode("classify", classify))
		.addNode("responder", traceNode("responder", respond))
		.addNode("entityExtractor", traceNode("entityExtractor", extractEntities))
		.addNode("queryDataSource", traceNode("queryDataSource", queryDataSource))
		.addNode("align", traceNode("align", checkAlignment))
		.addNode("aggregate", traceNode("aggregate", aggregate))
		.addNode("validate", traceNode("validate", validate))
		.addNode("followUp", traceNode("followUp", generateSuggestions))

		// Entry
		.addEdge("__start__", "classify")

		// Classify -> responder (simple) or entityExtractor (complex)
		.addConditionalEdges("classify", (state) => {
			return state.queryComplexity === "simple" ? "responder" : "entityExtractor";
		})

		// Simple path: responder -> followUp -> END
		.addEdge("responder", "followUp")
		.addEdge("followUp", END)

		// EntityExtractor fans out to sub-agents via Send[]
		.addConditionalEdges("entityExtractor", supervise)

		// Sub-agent results flow to alignment
		.addEdge("queryDataSource", "align")

		// Alignment -> Send[] retries or aggregate
		.addConditionalEdges("align", routeAfterAlignment, ["queryDataSource", "aggregate"])

		// Aggregate -> validate
		.addEdge("aggregate", "validate")

		// Validate -> retry aggregate or followUp -> END
		.addConditionalEdges("validate", (state) => {
			return shouldRetryValidation(state) ? "aggregate" : "followUp";
		});

	const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
	return graph.compile({ checkpointer });
}
