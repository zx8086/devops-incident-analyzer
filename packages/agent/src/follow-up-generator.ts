// agent/src/follow-up-generator.ts
import { getLogger } from "@devops-agent/observability";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createLlm } from "./llm.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:follow-up-generator");

const MIN_SUGGESTION_LENGTH = 10;
const MAX_SUGGESTION_LENGTH = 100;

const FOLLOW_UP_PROMPT = `Given the DevOps incident analysis assistant's response below, suggest 3 relevant follow-up questions the user might want to ask next. The assistant analyzes Elasticsearch, Kafka, Couchbase Capella, and Kong Konnect data.

Each suggestion should be a short, actionable question (under 100 chars).

Return ONLY a JSON array of strings, no explanation:
["suggestion 1", "suggestion 2", "suggestion 3"]`;

const FALLBACK_TEMPLATES: Record<string, string[]> = {
	elastic: ["Check cluster health across deployments", "Show recent error log patterns"],
	kafka: ["List consumer group lag", "Show topic partition details"],
	couchbase: ["Check bucket memory usage", "Show slow query analysis"],
	konnect: ["List API gateway routes", "Show plugin configuration"],
	generic: ["Compare across all datasources", "Show a timeline of recent changes"],
};

export function generateFallbackSuggestions(toolsUsed: string[]): string[] {
	const suggestions: string[] = [];

	if (toolsUsed.some((t) => /elastic|cluster|indices|search/i.test(t))) {
		suggestions.push(...(FALLBACK_TEMPLATES.elastic ?? []));
	}
	if (toolsUsed.some((t) => /kafka|topic|consumer|producer/i.test(t))) {
		suggestions.push(...(FALLBACK_TEMPLATES.kafka ?? []));
	}
	if (toolsUsed.some((t) => /couchbase|capella|bucket|n1ql/i.test(t))) {
		suggestions.push(...(FALLBACK_TEMPLATES.couchbase ?? []));
	}
	if (toolsUsed.some((t) => /konnect|kong|gateway|route|plugin/i.test(t))) {
		suggestions.push(...(FALLBACK_TEMPLATES.konnect ?? []));
	}

	if (suggestions.length === 0) {
		suggestions.push(...(FALLBACK_TEMPLATES.generic ?? []));
	}

	return suggestions.slice(0, 4);
}

function extractToolNamesFromResults(state: AgentStateType): string[] {
	return state.dataSourceResults
		.filter((r) => r.status === "success")
		.flatMap((r) => r.toolOutputs?.map((t) => t.toolName) ?? []);
}

function parseSuggestions(content: string): string[] | null {
	const match = content.match(/\[[\s\S]*\]/);
	if (!match) return null;

	try {
		const parsed = JSON.parse(match[0]);
		if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
			const filtered = parsed.filter(
				(s: string) => s.length >= MIN_SUGGESTION_LENGTH && s.length <= MAX_SUGGESTION_LENGTH,
			);
			return filtered.length > 0 ? filtered.slice(0, 4) : null;
		}
	} catch {
		return null;
	}
	return null;
}

// LangGraph node function -- inherits trace context via RunnableConfig
export async function generateSuggestions(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	const toolsUsed = extractToolNamesFromResults(state);
	const responseText = state.finalAnswer;

	if (!responseText || responseText.length < 50) {
		logger.info("Short or missing response, using fallback suggestions");
		return { suggestions: generateFallbackSuggestions(toolsUsed) };
	}

	try {
		const llm = createLlm("followUp");
		const truncated = responseText.slice(0, 1000);
		const result = await llm.invoke([new SystemMessage(FOLLOW_UP_PROMPT), new HumanMessage(truncated)], config);

		const content = typeof result.content === "string" ? result.content : "";
		const suggestions = parseSuggestions(content);
		if (suggestions) {
			logger.info({ count: suggestions.length }, "Generated follow-up suggestions");
			return { suggestions };
		}

		logger.warn("LLM suggestions did not pass validation, using fallbacks");
		return { suggestions: generateFallbackSuggestions(toolsUsed) };
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"LLM suggestion generation failed, using fallbacks",
		);
		return { suggestions: generateFallbackSuggestions(toolsUsed) };
	}
}
