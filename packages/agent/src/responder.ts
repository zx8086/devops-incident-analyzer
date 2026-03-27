// agent/src/responder.ts

import { getLogger } from "@devops-agent/observability";
import { AIMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createLlm } from "./llm.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:responder");

const RESPONDER_PROMPT = `You are a DevOps incident analysis assistant that helps engineers investigate and resolve infrastructure issues across Elasticsearch, Kafka, Couchbase Capella, and Kong Konnect.

You can help with:
- Greetings and general conversation
- Explaining your capabilities
- Answering general DevOps questions from knowledge

Your capabilities when connected to datasources:
- Elasticsearch: cluster health, index stats, shard allocation, log search, mapping inspection
- Kafka: topic listing, consumer group lag, message consumption, broker health
- Couchbase Capella: bucket health, N1QL query analysis, system vitals, node status
- Kong Konnect: API gateway routes, services, plugins, request analytics

Keep responses concise and direct. Do not fabricate infrastructure data -- only answer from general knowledge.
Do not ask excessive clarifying questions. If the user asks something you can answer from general knowledge, answer it directly.`;

export async function respond(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
	logger.info("Simple query responder invoked");

	const llm = createLlm("responder");
	const startTime = Date.now();
	const response = await llm.invoke([{ role: "system", content: RESPONDER_PROMPT }, ...state.messages], config);
	const answer = String(response.content);

	logger.info({ duration: Date.now() - startTime, answerLength: answer.length }, "Responder complete");
	return {
		messages: [new AIMessage({ content: answer })],
		finalAnswer: answer,
	};
}
