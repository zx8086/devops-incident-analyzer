// agent/src/follow-up-generator.ts
import { getLogger } from "@devops-agent/observability";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm, DeadlineExceededError, type InvokableLlm, invokeWithDeadline } from "./llm.ts";
import { parseLlmJson } from "./llm-json.ts";
import { appendDailyLog } from "./memory-writer.ts";
import { extractTextFromContent } from "./message-utils.ts";
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

// SIO-1687: kill switch for the tool-failure breadcrumb, default ON (same idiom
// as isHilLearningEnabled). The breadcrumb rides the existing dailylog write, so
// disabling it changes what one line says, never whether the line is written.
export function isDailyLogToolFailuresEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.DAILYLOG_TOOL_FAILURES_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// SIO-1687: "<datasource>:<category>" per distinct failure kind this turn.
// toolErrors already carries the closed ToolErrorCategory enum, so no
// re-classification is needed -- the categories the aggregator and loop guard
// act on are the ones recorded. Deduped and bounded so one flapping datasource
// cannot dominate the line.
const MAX_TOOL_FAILURE_TAGS = 12;
export function collectToolFailures(state: AgentStateType): string[] {
	const tags = new Set<string>();
	for (const r of state.dataSourceResults) {
		for (const e of r.toolErrors ?? []) {
			if (r.dataSourceId && e.category) tags.add(`${r.dataSourceId}:${e.category}`);
		}
	}
	return [...tags].sort().slice(0, MAX_TOOL_FAILURE_TAGS);
}

// SIO-845: append a one-line breadcrumb to memory/runtime/dailylog.md per
// completed investigation. No-op when live memory is disabled; never throws
// (a memory write must never break answer delivery).
function recordDailyLog(state: AgentStateType): void {
	try {
		const datasources = [...new Set(state.dataSourceResults.map((r) => r.dataSourceId))].filter(
			(d): d is string => typeof d === "string" && d.length > 0,
		);
		const services = (state.normalizedIncident.affectedServices ?? []).map((s) => s.name);
		const toolFailures = isDailyLogToolFailuresEnabled() ? collectToolFailures(state) : [];
		// SIO-1687: the breadcrumb only reaches the daily log when LIVE_MEMORY_ENABLED
		// is on, so without this the classes are invisible on every dev/test run and
		// unqueryable in prod. Categories are a closed enum, safe to log verbatim.
		if (toolFailures.length > 0) {
			logger.info(
				{ event: "dailylog.tool_failures", requestId: state.requestId, toolFailures },
				"tool failures recorded for this turn",
			);
		}
		appendDailyLog({
			requestId: state.requestId,
			services,
			severity: state.normalizedIncident.severity,
			confidence: state.confidenceScore || undefined,
			datasources,
			toolFailures: toolFailures.length > 0 ? toolFailures : undefined,
		});
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "dailylog append failed; ignoring");
	}
}

// The only array-shaped LLM-JSON site: the suggestions prompt asks for a bare JSON array,
// not an object envelope.
function parseSuggestions(content: string): string[] | null {
	const result = parseLlmJson(content, z.array(z.string()), { shape: "array" });
	if (!result.ok) return null;
	const filtered = result.data.filter((s) => s.length >= MIN_SUGGESTION_LENGTH && s.length <= MAX_SUGGESTION_LENGTH);
	return filtered.length > 0 ? filtered.slice(0, 4) : null;
}

// LangGraph node function -- inherits trace context via RunnableConfig
export async function generateSuggestions(
	state: AgentStateType,
	config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	// SIO-845: terminal node on both simple and complex paths -- the natural
	// place to record a per-investigation breadcrumb to live memory.
	recordDailyLog(state);

	const toolsUsed = extractToolNamesFromResults(state);
	const responseText = state.finalAnswer;

	if (!responseText || responseText.length < 50) {
		logger.info("Short or missing response, using fallback suggestions");
		return { suggestions: generateFallbackSuggestions(toolsUsed) };
	}

	try {
		const llm = createLlm("followUp");
		const truncated = responseText.slice(0, 1000);
		const result = await invokeWithDeadline(
			llm as InvokableLlm,
			"followUp",
			[new SystemMessage(FOLLOW_UP_PROMPT), new HumanMessage(truncated)],
			config as { signal?: AbortSignal; [key: string]: unknown } | undefined,
		);

		// SIO-1222: an empty string here silently produced fallback suggestions on every turn.
		const content = extractTextFromContent(result.content);
		const suggestions = parseSuggestions(content);
		if (suggestions) {
			logger.info({ count: suggestions.length }, "Generated follow-up suggestions");
			return { suggestions };
		}

		logger.warn("LLM suggestions did not pass validation, using fallbacks");
		return { suggestions: generateFallbackSuggestions(toolsUsed) };
	} catch (error) {
		if (error instanceof DeadlineExceededError) {
			logger.warn(
				{ role: error.role, deadlineMs: error.deadlineMs },
				"Follow-up suggestion generation exceeded deadline; soft-failing",
			);
			return {
				suggestions: generateFallbackSuggestions(toolsUsed),
				partialFailures: [{ node: "followUp", reason: "timeout" }],
			};
		}
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"LLM suggestion generation failed, using fallbacks",
		);
		return { suggestions: generateFallbackSuggestions(toolsUsed) };
	}
}
