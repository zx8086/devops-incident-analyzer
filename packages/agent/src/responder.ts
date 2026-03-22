// agent/src/responder.ts
import { AIMessage } from "@langchain/core/messages";
import { createLlm } from "./llm.ts";
import type { AgentStateType } from "./state.ts";
import { buildSystemPrompt, loadAgent } from "@devops-agent/gitagent-bridge";
import { join } from "node:path";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

export async function respond(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const agent = loadAgent(AGENTS_DIR);
  const systemPrompt = buildSystemPrompt(agent, []);

  const llm = createLlm("responder");
  const response = await llm.invoke([{ role: "system", content: systemPrompt }, ...state.messages]);

  return {
    messages: [new AIMessage({ content: String(response.content) })],
    finalAnswer: String(response.content),
  };
}
