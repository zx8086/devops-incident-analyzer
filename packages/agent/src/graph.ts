// agent/src/graph.ts

import { createCheckpointer } from "@devops-agent/checkpointer";
import { END, StateGraph } from "@langchain/langgraph";
import { aggregate } from "./aggregator.ts";
import { checkAlignment, routeAfterAlignment } from "./alignment.ts";
import { classify } from "./classifier.ts";
import { extractEntities } from "./entity-extractor.ts";
import { respond } from "./responder.ts";
import { AgentState } from "./state.ts";
import { queryDataSource } from "./sub-agent.ts";
import { supervise } from "./supervisor.ts";
import { shouldRetryValidation, validate } from "./validator.ts";

export function buildGraph(config?: { checkpointerType?: "memory" | "sqlite" }) {
	const graph = new StateGraph(AgentState)
		.addNode("classify", classify)
		.addNode("responder", respond)
		.addNode("entityExtractor", extractEntities)
		.addNode("queryDataSource", queryDataSource)
		.addNode("align", checkAlignment)
		.addNode("aggregate", aggregate)
		.addNode("validate", validate)

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
