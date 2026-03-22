// agent/src/classifier.ts
import { getLogger } from "@devops-agent/observability";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLlm } from "./llm.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:classifier");

// Queries that match these are always SIMPLE (unless also matching COMPLEX_PATTERNS)
const SIMPLE_PATTERNS = [
	/^(hi|hey|hello|howdy|greetings)\b/i,
	/^(thanks?|thank\s*you|thx|ty)\b/i,
	/\b(help|what can you do|capabilities|how do you work)\b/i,
	/^(who are you|what are you)\b/i,
];

// Infrastructure keywords that indicate the user wants actual data from datasources
const COMPLEX_PATTERNS = [
	/\b(cluster|clusters|node|nodes|server|servers)\b/i,
	/\b(health|status|healthy|unhealthy|down|degraded)\b/i,
	/\b(index|indices|shard|shards|replica|primary)\b/i,
	/\b(log|logs|error|errors|exception|exceptions|warning)\b/i,
	/\b(topic|topics|consumer|consumer.?group|lag|offset)\b/i,
	/\b(bucket|buckets|collection|scope|n1ql|query|queries)\b/i,
	/\b(route|routes|service|services|plugin|plugins|upstream)\b/i,
	/\b(api.?gateway|gateway|kong|konnect)\b/i,
	/\b(kafka|elastic|elasticsearch|couchbase|capella)\b/i,
	/\b(incident|outage|alert|alerts|pager|oncall)\b/i,
	/\b(latency|throughput|error.?rate|p99|p95|cpu|memory|disk)\b/i,
	/\b(check|monitor|inspect|diagnose|investigate|analyze|analyse)\b/i,
	/\b(how.+doing|what.+happening|what.+wrong|is.+ok|are.+ok)\b/i,
];

const FOLLOW_UP_PATTERNS = [
	/try again/i,
	/retry/i,
	/more details/i,
	/can you also/i,
	/what about/i,
	/^yes\b/i,
	/do it again/i,
	/run that again/i,
];

const MAX_CONTEXT_WORD_COUNT = 15;
const MAX_CONTEXT_MESSAGES = 4;

interface CacheEntry {
	value: "simple" | "complex";
	expiresAt: number;
}

const classificationCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_SIZE = 500;

function getCached(query: string): "simple" | "complex" | undefined {
	const key = query.trim().toLowerCase();
	const entry = classificationCache.get(key);
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) {
		classificationCache.delete(key);
		return undefined;
	}
	return entry.value;
}

function setCached(query: string, value: "simple" | "complex"): void {
	const key = query.trim().toLowerCase();
	if (classificationCache.size >= CACHE_MAX_SIZE) {
		const firstKey = classificationCache.keys().next().value;
		if (firstKey !== undefined) classificationCache.delete(firstKey);
	}
	classificationCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function patternClassify(query: string): "simple" | "complex" | null {
	const trimmed = query.trim();

	// Simple patterns only count if no complex patterns also match
	if (SIMPLE_PATTERNS.some((p) => p.test(trimmed))) {
		if (!COMPLEX_PATTERNS.some((p) => p.test(trimmed))) {
			return "simple";
		}
	}

	if (COMPLEX_PATTERNS.some((p) => p.test(trimmed))) {
		return "complex";
	}

	return null;
}

function needsConversationContext(query: string, messageCount: number): boolean {
	if (messageCount <= 1) return false;
	const wordCount = query.trim().split(/\s+/).length;
	return wordCount <= MAX_CONTEXT_WORD_COUNT;
}

function buildContextSummary(messages: BaseMessage[]): string {
	const recent = messages.slice(-MAX_CONTEXT_MESSAGES - 1, -1);
	return recent
		.map((m) => {
			const role = m.getType() === "human" ? "User" : "Assistant";
			const text = typeof m.content === "string" ? m.content : "";
			return `${role}: ${text.slice(0, 150)}`;
		})
		.join("\n");
}

const CLASSIFIER_PROMPT = `Classify the user's query as SIMPLE or COMPLEX.

SIMPLE: greetings, thanks, help requests, capability questions, or questions answerable without querying any datasource.
COMPLEX: anything requiring real data from infrastructure -- cluster health, logs, errors, metrics, performance, incidents, consumer lag, API gateway stats, database queries, or any question about how systems are doing.

When in doubt, classify as COMPLEX. It is better to query datasources unnecessarily than to miss a user's intent.

Respond with exactly one word: SIMPLE or COMPLEX`;

const CLASSIFIER_PROMPT_WITH_CONTEXT = `Classify the user's latest query as SIMPLE or COMPLEX.

SIMPLE: greetings, thanks, help requests, capability questions, or questions answerable without querying any datasource.
COMPLEX: anything requiring real data from infrastructure -- cluster health, logs, errors, metrics, performance, incidents, consumer lag, API gateway stats, database queries, or any question about how systems are doing.

IMPORTANT: If the user's message is a follow-up that refers to a previous complex query (e.g. "try again", "do it again", "retry", "yes", "run that again"), classify as COMPLEX. Consider the conversation context below.

When in doubt, classify as COMPLEX.

Respond with exactly one word: SIMPLE or COMPLEX`;

export async function classify(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const lastMessage = state.messages[state.messages.length - 1];
	if (!lastMessage || lastMessage._getType() !== "human") {
		logger.info("No human message found, defaulting to simple");
		return { queryComplexity: "simple" };
	}

	const query = typeof lastMessage.content === "string" ? lastMessage.content : String(lastMessage.content);
	const trimmed = query.trim();
	logger.info({ query: trimmed.slice(0, 100) }, "Classifying query");

	// Fast path: regex pattern match
	const patternResult = patternClassify(trimmed);
	if (patternResult) {
		logger.info({ result: patternResult, method: "regex" }, "Classification complete");
		if (patternResult === "complex") {
			return { queryComplexity: "complex" };
		}
		return { queryComplexity: "simple" };
	}

	// Follow-up detection
	if (FOLLOW_UP_PATTERNS.some((p) => p.test(trimmed))) {
		logger.info({ result: "complex", method: "follow-up-regex" }, "Classification complete");
		return { queryComplexity: "complex", isFollowUp: true };
	}

	// SIO-504 pattern: short/ambiguous messages with conversation history need context
	const hasContext = needsConversationContext(trimmed, state.messages.length);

	if (!hasContext) {
		const cached = getCached(trimmed);
		if (cached) {
			logger.info({ result: cached, method: "cache" }, "Classification complete");
			return { queryComplexity: cached };
		}
	}

	// LLM classification for ambiguous queries
	logger.info({ hasContext }, "Using LLM for classification");
	try {
		const llm = createLlm("classifier");
		const llmMessages: BaseMessage[] = hasContext
			? [
					new SystemMessage(CLASSIFIER_PROMPT_WITH_CONTEXT),
					new HumanMessage(`Conversation context:\n${buildContextSummary(state.messages)}\n\nLatest query: ${trimmed}`),
				]
			: [new SystemMessage(CLASSIFIER_PROMPT), new HumanMessage(trimmed)];

		const response = await llm.invoke(llmMessages);
		const content = typeof response.content === "string" ? response.content.trim().toUpperCase() : "";
		const classification = content.includes("SIMPLE") ? ("simple" as const) : ("complex" as const);

		if (!hasContext) {
			setCached(trimmed, classification);
		}
		logger.info({ result: classification, method: "llm" }, "Classification complete");
		return { queryComplexity: classification };
	} catch (error) {
		logger.error(
			{ error: error instanceof Error ? error.message : String(error) },
			"LLM classification failed, defaulting to complex",
		);
		return { queryComplexity: "complex" };
	}
}
