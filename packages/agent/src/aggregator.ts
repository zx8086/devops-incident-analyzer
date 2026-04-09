// agent/src/aggregator.ts
import { getLogger } from "@devops-agent/observability";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
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

	// Only mention datasources that were actually queried
	const queriedSources = state.targetDataSources;
	const scopeNote =
		queriedSources.length > 0
			? `\n\nIMPORTANT: Only the following datasources were queried for this report: ${queriedSources.join(", ")}. Do NOT mention, list, or create sections for datasources that were not queried. The user explicitly selected these datasources -- omitting others is intentional, not a gap.`
			: "";

	// SIO-626: Surface unavailable datasources so the report explicitly mentions gaps
	const skipped = state.skippedDataSources ?? [];
	const unavailableNote =
		skipped.length > 0
			? `\n\nUNAVAILABLE DATASOURCES: ${skipped.join("; ")}. Include these in a "Gaps" section of the report so the user knows which datasources could not be reached.`
			: "";

	// Datasources that return point-in-time state (not timestamped events) should not
	// be penalized in the confidence score for lacking a timeline.
	const STATUS_ORIENTED_SOURCES = new Set(["kafka", "couchbase", "konnect"]);
	const hasEventSources = queriedSources.some((s) => !STATUS_ORIENTED_SOURCES.has(s));
	const timelineGuidance = hasEventSources
		? ""
		: `\n\nTIMELINE GUIDANCE: The queried datasources (${queriedSources.join(", ")}) return infrastructure state snapshots, not timestamped event logs. A correlated timeline is not expected for these sources. Do not penalize the confidence score for the absence of timestamps or timeline data. If no event-log datasources (e.g. elastic) were queried, omit the correlated timeline section entirely.`;

	// When tool errors indicate connectivity problems, instruct the LLM to lead with that
	const failedSources = state.dataSourceResults.filter((r) => r.toolErrors && r.toolErrors.length > 0);
	const connectivityGuidance =
		failedSources.length > 0
			? `\n\nTOOL FAILURE GUIDANCE: ${failedSources.length} datasource(s) reported tool errors. When tool errors show repeated metadata/connection failures, the report summary must lead with the infrastructure connectivity problem (e.g. "brokers are unreachable") as the primary finding. Do not present connectivity failure as one possibility among equals -- state it as the leading diagnosis and list other causes as secondary.`
			: "";

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
			`Aggregate these datasource findings into a unified incident report. Only reference data present below -- do not fabricate metrics or timestamps.${scopeNote}${unavailableNote}${timelineGuidance}${connectivityGuidance}\n\nReport generation timestamp: ${new Date().toISOString()}. Use this exact value as the "Generated" date in the report header. Do not invent a different timestamp.\n\nIf no specific timestamps are available from the datasource findings (i.e., all observations are current-state snapshots rather than timestamped events), use "Current State Assessment" as the section heading instead of "Correlated Timeline", and use "Current" in the time column instead of fabricating timestamps.\n\n${resultsBlock}\n\nProvide: summary, ${hasEventSources ? "correlated timeline (markdown table), " : ""}findings per datasource, confidence score (0.0-1.0), and any gaps.${priorAnswer ? "\n\nIMPORTANT: Focus on answering the current query. Reference prior findings where relevant but do not repeat the full prior report." : ""}`,
		),
	);

	return messages;
}

export async function aggregate(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
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
			const header = `### ${r.dataSourceId} [${status}] (${r.duration ?? 0}ms)`;

			// Surface tool-level errors so the LLM can distinguish "some tools failed"
			// from "all tools failed" and identify the failure pattern (auth, connectivity, etc.)
			const toolErrorBlock =
				r.toolErrors && r.toolErrors.length > 0
					? `\n\nTool errors (${r.toolErrors.length} failures):\n${r.toolErrors
							.map((e) => `- ${e.toolName} [${e.category}]: ${e.message}`)
							.join("\n")}`
					: "";

			return `${header}${toolErrorBlock}\n${data}`;
		})
		.join("\n\n");

	const llm = createLlm("aggregator");
	const messages = buildAggregatorMessages(state, resultsBlock);

	logger.info("Invoking LLM for aggregation");
	const startTime = Date.now();
	const response = await llm.invoke(messages, config);

	const answer = String(response.content);
	logger.info({ duration: Date.now() - startTime, answerLength: answer.length }, "Aggregation complete");
	return {
		messages: [new AIMessage({ content: answer })],
		finalAnswer: answer,
	};
}
