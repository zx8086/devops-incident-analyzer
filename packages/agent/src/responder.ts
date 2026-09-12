// agent/src/responder.ts

import { getLogger } from "@devops-agent/observability";
import { DATA_SOURCE_IDS } from "@devops-agent/shared";
import { AIMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:responder");

// Keyed by the canonical datasource ids so the capability list can never drift from the
// pipeline's real datasource set again (the previous literal listed four of the seven).
const DATASOURCE_CAPABILITIES: Record<(typeof DATA_SOURCE_IDS)[number], string> = {
	elastic: "Elasticsearch: cluster health, index stats, shard allocation, log and APM search, ML anomaly records",
	kafka: "Kafka / Confluent: topics, consumer group lag, DLQ topics, broker and Confluent component health",
	couchbase: "Couchbase Capella: bucket health, N1QL query analysis, index advice, system vitals, node status",
	konnect: "Kong Konnect: API gateway routes, services, plugins, request analytics",
	gitlab: "GitLab: recent deploys, pipeline failures, merge requests, code search and blast radius",
	atlassian: "Atlassian: linked Jira incidents, incident history, Confluence runbooks",
	aws: "AWS: per-estate ECS services, CloudWatch logs and alarms, Route 53 and IAM-scoped introspection",
};

const RESPONDER_PROMPT = `You are a DevOps incident analysis assistant that helps engineers investigate and resolve infrastructure issues across ${DATA_SOURCE_IDS.join(", ")}.

You can help with:
- Greetings and general conversation
- Explaining your capabilities
- Answering general DevOps questions from knowledge

Your capabilities when connected to datasources:
${DATA_SOURCE_IDS.map((id) => `- ${DATASOURCE_CAPABILITIES[id]}`).join("\n")}

Keep responses concise and direct. Do not fabricate infrastructure data -- only answer from general knowledge.
Do not ask excessive clarifying questions. If the user asks something you can answer from general knowledge, answer it directly.`;

export async function respond(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
	logger.info("Simple query responder invoked");

	const llm = createLlm("responder");
	const startTime = Date.now();
	const response = await llm.invoke([{ role: "system", content: RESPONDER_PROMPT }, ...state.messages], config);
	const answer = extractTextFromContent(response.content);

	logger.info({ duration: Date.now() - startTime, answerLength: answer.length }, "Responder complete");
	return {
		messages: [new AIMessage({ content: answer })],
		finalAnswer: answer,
	};
}
