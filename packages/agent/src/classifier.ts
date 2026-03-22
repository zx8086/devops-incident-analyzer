// agent/src/classifier.ts
import { createLlm } from "./llm.ts";
import type { AgentStateType } from "./state.ts";

const SIMPLE_PATTERNS = [/^(hi|hello|hey)\b/i, /^help\b/i, /^what can you do/i, /^who are you/i, /^thanks?\b/i];

const FOLLOW_UP_PATTERNS = [/try again/i, /retry/i, /more details/i, /can you also/i, /what about/i];

const classificationCache = new Map<string, "simple" | "complex">();

export async function classify(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const lastMessage = state.messages[state.messages.length - 1];
  if (!lastMessage || lastMessage._getType() !== "human") {
    return { queryComplexity: "simple" };
  }

  const query = typeof lastMessage.content === "string" ? lastMessage.content : String(lastMessage.content);
  const trimmed = query.trim();

  // Fast path: regex matching
  if (SIMPLE_PATTERNS.some((p) => p.test(trimmed))) {
    return { queryComplexity: "simple" };
  }

  // Follow-up detection
  if (FOLLOW_UP_PATTERNS.some((p) => p.test(trimmed))) {
    return { queryComplexity: "complex", isFollowUp: true };
  }

  // Cache check
  const cached = classificationCache.get(trimmed);
  if (cached) {
    return { queryComplexity: cached };
  }

  // LLM classification for ambiguous queries
  const llm = createLlm("classifier");
  const response = await llm.invoke([
    {
      role: "system",
      content:
        "Classify this query as SIMPLE or COMPLEX. SIMPLE: greetings, help requests, status checks. COMPLEX: incident analysis, log searches, performance issues, multi-system queries. Reply with a single word: SIMPLE or COMPLEX.",
    },
    { role: "human", content: trimmed },
  ]);

  const classification = String(response.content).trim().toUpperCase().includes("SIMPLE") ? "simple" : "complex";

  classificationCache.set(trimmed, classification);
  return { queryComplexity: classification };
}
