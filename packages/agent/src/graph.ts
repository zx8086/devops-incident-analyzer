// agent/src/graph.ts
import { StateGraph, END } from "@langchain/langgraph";
import { AgentState } from "./state.ts";
import { classify } from "./classifier.ts";
import { respond } from "./responder.ts";
import { extractEntities } from "./entity-extractor.ts";
import { supervise } from "./supervisor.ts";
import { queryDataSource } from "./sub-agent.ts";
import { aggregate } from "./aggregator.ts";
import { checkAlignment } from "./alignment.ts";
import { validate, shouldRetryValidation } from "./validator.ts";
import { createCheckpointer } from "@devops-agent/checkpointer";

export function buildGraph(config?: { checkpointerType?: "memory" | "sqlite" }) {
  const graph = new StateGraph(AgentState)
    .addNode("classify", classify)
    .addNode("responder", respond)
    .addNode("entityExtractor", extractEntities)
    .addNode("queryDataSource", queryDataSource)
    .addNode("align", (state) => {
      const result = checkAlignment(state);
      const { shouldRetry: _, ...stateUpdate } = result;
      return stateUpdate;
    })
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
    // (supervisor logic is the conditional edge function, not a separate node)
    .addConditionalEdges("entityExtractor", supervise)

    // Sub-agent results flow to alignment
    .addEdge("queryDataSource", "align")

    // Alignment -> retry or aggregate
    .addConditionalEdges("align", (state) => {
      const result = checkAlignment(state);
      return result.shouldRetry ? "queryDataSource" : "aggregate";
    })

    // Aggregate -> validate
    .addEdge("aggregate", "validate")

    // Validate -> END or retry aggregate
    .addConditionalEdges("validate", (state) => {
      return shouldRetryValidation(state) ? "aggregate" : "__end__";
    });

  const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
  return graph.compile({ checkpointer });
}
