// agent/src/responder.ts

import { getLogger } from "@devops-agent/observability";
import { buildSystemPrompt, loadAgent } from "@devops-agent/gitagent-bridge";
import { AIMessage } from "@langchain/core/messages";
import { createLlm } from "./llm.ts";
import { getAgentsDir } from "./paths.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:responder");

export async function respond(state: AgentStateType): Promise<Partial<AgentStateType>> {
	logger.info("Simple query responder invoked");
	const agent = loadAgent(getAgentsDir());
	const systemPrompt = buildSystemPrompt(agent, []);

	const llm = createLlm("responder");
	const startTime = Date.now();
	const response = await llm.invoke([{ role: "system", content: systemPrompt }, ...state.messages]);
	const answer = String(response.content);

	logger.info({ duration: Date.now() - startTime, answerLength: answer.length }, "Responder complete");
	return {
		messages: [new AIMessage({ content: answer })],
		finalAnswer: answer,
	};
}
