// agent/src/aggregator.ts
import { AIMessage } from "@langchain/core/messages";
import { createLlm } from "./llm.ts";
import { buildOrchestratorPrompt } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

export async function aggregate(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const results = state.dataSourceResults;
  if (results.length === 0) {
    return {
      messages: [new AIMessage({ content: "No datasource results to aggregate." })],
      finalAnswer: "No datasource results to aggregate.",
    };
  }

  const resultsBlock = results
    .map((r) => {
      const status = r.status === "success" ? "OK" : `ERROR: ${r.error ?? "unknown"}`;
      const data = r.status === "success" ? String(r.data) : "No data";
      return `### ${r.dataSourceId} [${status}] (${r.duration ?? 0}ms)\n${data}`;
    })
    .join("\n\n");

  const llm = createLlm("aggregator");
  const systemPrompt = buildOrchestratorPrompt();

  const response = await llm.invoke([
    { role: "system", content: systemPrompt },
    ...state.messages,
    {
      role: "human",
      content: `Aggregate these datasource findings into a unified incident report. Only reference data present below -- do not fabricate metrics or timestamps.\n\n${resultsBlock}\n\nProvide: summary, correlated timeline (markdown table), findings per datasource, confidence score (0.0-1.0), and any gaps.`,
    },
  ]);

  const answer = String(response.content);
  return {
    messages: [new AIMessage({ content: answer })],
    finalAnswer: answer,
  };
}
