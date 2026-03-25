// agent/src/aggregator.ts
import { getLogger } from "@devops-agent/observability";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { buildOrchestratorPrompt } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:aggregator");

function buildAggregatorMessages(state: AgentStateType, resultsBlock: string): BaseMessage[] {
	const systemPrompt = buildOrchestratorPrompt();
	const priorAnswer = state.finalAnswer;
	const lastUserMessage = state.messages.filter((m) => m._getType() === "human").pop();
	const userQuery = lastUserMessage ? extractTextFromContent(lastUserMessage.content) : "";

	const messages: BaseMessage[] = [new SystemMessage(systemPrompt)];

	// On follow-ups with a prior answer, provide it as condensed context instead of
	// replaying the full conversation history (which can exceed token limits)
	if (priorAnswer) {
		messages.push(
			new HumanMessage(
				`Previous analysis (for context -- do not repeat verbatim, only reference or update relevant sections):\n\n${priorAnswer}`,
			),
		);
	}

	if (userQuery) {
		messages.push(new HumanMessage(`Current query: ${userQuery}`));
	}

	messages.push(
		new HumanMessage(
			`Aggregate these datasource findings into a unified incident report. Only reference data present below -- do not fabricate metrics or timestamps.\n\n${resultsBlock}\n\nProvide: summary, correlated timeline (markdown table), findings per datasource, confidence score (0.0-1.0), and any gaps.${priorAnswer ? "\n\nIMPORTANT: Focus on answering the current query. Reference prior findings where relevant but do not repeat the full prior report." : ""}`,
		),
	);

	return messages;
}

export async function aggregate(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const results = state.dataSourceResults;
	if (results.length === 0) {
		logger.warn("No datasource results to aggregate");
		return {
			messages: [new AIMessage({ content: "No datasource results to aggregate." })],
			finalAnswer: "No datasource results to aggregate.",
		};
	}

	const summary = results.map((r) => ({
		dataSourceId: r.dataSourceId,
		status: r.status,
		duration: r.duration,
		dataLength: r.status === "success" ? String(r.data).length : 0,
	}));
	logger.info({ resultCount: results.length, results: summary }, "Aggregating datasource results");

	const resultsBlock = results
		.map((r) => {
			const status = r.status === "success" ? "OK" : `ERROR: ${r.error ?? "unknown"}`;
			const data = r.status === "success" ? String(r.data) : "No data";
			return `### ${r.dataSourceId} [${status}] (${r.duration ?? 0}ms)\n${data}`;
		})
		.join("\n\n");

	const llm = createLlm("aggregator");
	const messages = buildAggregatorMessages(state, resultsBlock);

	logger.info("Invoking LLM for aggregation");
	const startTime = Date.now();
	const response = await llm.invoke(messages);

	const answer = String(response.content);
	logger.info({ duration: Date.now() - startTime, answerLength: answer.length }, "Aggregation complete");
	return {
		messages: [new AIMessage({ content: answer })],
		finalAnswer: answer,
	};
}
