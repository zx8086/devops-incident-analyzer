// agent/src/aggregator.ts
import { getLogger } from "@devops-agent/observability";
import { AIMessage } from "@langchain/core/messages";
import { createLlm } from "./llm.ts";
import { buildOrchestratorPrompt } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:aggregator");

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
	const systemPrompt = buildOrchestratorPrompt();

	logger.info("Invoking LLM for aggregation");
	const startTime = Date.now();
	const response = await llm.invoke([
		{ role: "system", content: systemPrompt },
		...state.messages,
		{
			role: "human",
			content: `Aggregate these datasource findings into a unified incident report. Only reference data present below -- do not fabricate metrics or timestamps.\n\n${resultsBlock}\n\nProvide: summary, correlated timeline (markdown table), findings per datasource, confidence score (0.0-1.0), and any gaps.`,
		},
	]);

	const answer = String(response.content);
	logger.info({ duration: Date.now() - startTime, answerLength: answer.length }, "Aggregation complete");
	return {
		messages: [new AIMessage({ content: answer })],
		finalAnswer: answer,
	};
}
