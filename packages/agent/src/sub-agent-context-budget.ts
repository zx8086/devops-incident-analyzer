// agent/src/sub-agent-context-budget.ts
//
// SIO-1250: bound the CUMULATIVE context of a sub-agent ReAct loop.
//
// SUBAGENT_TOOL_RESULT_CAP_BYTES bounds each result individually, which is
// structurally incapable of bounding the sum: at elastic's recursionLimit of 40,
// ~6 results at the 131_072 cap already reach 200k tokens. SIO-1248 removed the
// bypass that made this fire on elasticsearch_search, but any tool returning
// several near-cap payloads reproduces it.
//
// Strategy: ELIDE CONTENT, NEVER REMOVE MESSAGES. Walking newest -> oldest, tool
// results are kept whole until the running total exceeds the budget; every older
// result has its content swapped for a short marker. Because no message is ever
// dropped, an AIMessage tool_call can never lose its ToolMessage (nor vice versa)
// -- the orphan case Bedrock rejects outright, and the sharp edge that makes the
// keep-last-N approach in state-pruning.ts risky here.
//
// Applied via createReactAgent's preModelHook, which returns `llmInputMessages`:
// that overrides what the model sees WITHOUT mutating canonical `messages`, so
// response.messages stays whole for extractToolErrors and the SIO-1248 raw
// capture that feeds the typed-finding extractors.

import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";

// Measured 2026-07-27 on live eu-b2b runs: a sub-agent's system prompt + user
// message is ~9.3-9.9k tokens, and tool results drive essentially all subsequent
// growth (9,931 -> 75,208 input tokens over six LLM turns). 400KB of tool content
// is roughly 100-130k tokens depending on the JSON byte/token ratio, which leaves
// comfortable headroom under the 200k window for the base prompt, the assistant's
// own turns, and the final answer.
// Verified live 2026-07-27: at this default a normal eu-b2b elastic run elides NOTHING
// (peak in-context tool content 102,696 bytes) and scores 0.78 confidence vs a 0.72
// unbudgeted baseline -- i.e. it is a true no-op until the loop actually misbehaves.
//
// Do NOT tune this down aggressively. A deliberately harsh 60_000 run elided a live
// search result mid-investigation and the sub-agent then flailed on follow-up queries,
// hit the recursion limit, and scored 0.15. The budget is a backstop against overflow,
// not a context-reduction knob.
const DEFAULT_CONTEXT_BUDGET_BYTES = 400_000;

// Mirrors getSubAgentToolCapBytes' contract exactly: unset/empty/invalid/negative
// -> default, explicit "0" -> disabled (null).
export function getSubAgentContextBudgetBytes(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env.SUBAGENT_CONTEXT_BUDGET_BYTES;
	if (raw == null || raw === "") return DEFAULT_CONTEXT_BUDGET_BYTES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_CONTEXT_BUDGET_BYTES;
	if (parsed === 0) return null;
	if (parsed < 0) return DEFAULT_CONTEXT_BUDGET_BYTES;
	return Math.floor(parsed);
}

export interface ContextBudgetResult {
	messages: BaseMessage[];
	elidedCount: number;
	freedBytes: number;
	// Total tool-content bytes BEFORE eliding -- what the model would have received.
	totalBytes: number;
}

function contentBytes(content: unknown): number {
	if (typeof content === "string") return Buffer.byteLength(content, "utf8");
	if (content == null) return 0;
	try {
		// content-ok: measuring a ToolMessage result body, not rendering an AIMessage.
		return Buffer.byteLength(JSON.stringify(content) ?? "", "utf8");
	} catch {
		// content-ok: measuring the byte size of a ToolMessage result body (cycles only);
		// the value is never rendered or sent to the model, only counted.
		return Buffer.byteLength(String(content), "utf8");
	}
}

function elisionMarker(toolName: string | undefined, bytes: number): string {
	const who = toolName ?? "tool";
	return `[elided: ${bytes} bytes from an earlier ${who} result, dropped to stay within the sub-agent context budget. The full result was captured for analysis; re-query only if you still need these specifics.]`;
}

export function applyContextBudget(messages: BaseMessage[], budgetBytes: number): ContextBudgetResult {
	const toolIndexes: number[] = [];
	let totalBytes = 0;
	for (let i = 0; i < messages.length; i += 1) {
		const m = messages[i];
		if (m instanceof ToolMessage) {
			toolIndexes.push(i);
			totalBytes += contentBytes(m.content);
		}
	}

	if (budgetBytes <= 0 || totalBytes <= budgetBytes) {
		return { messages, elidedCount: 0, freedBytes: 0, totalBytes };
	}

	// Newest -> oldest: keep whole while the running total fits. The newest result is
	// always kept even if it alone busts the budget -- the per-result cap already
	// bounds it, and eliding it would leave the model nothing fresh to reason on.
	const keepWhole = new Set<number>();
	let running = 0;
	for (let k = toolIndexes.length - 1; k >= 0; k -= 1) {
		const idx = toolIndexes[k];
		if (idx == null) continue;
		const m = messages[idx];
		if (!m) continue;
		const bytes = contentBytes(m.content);
		const isNewest = k === toolIndexes.length - 1;
		if (isNewest || running + bytes <= budgetBytes) {
			keepWhole.add(idx);
			running += bytes;
		}
		// Once the budget is spent, everything older is elided. No `break` -- a later
		// small result should not be resurrected after a large one exhausted the budget,
		// which keeps the kept set a clean suffix of the timeline.
	}

	let elidedCount = 0;
	let freedBytes = 0;
	const out = messages.map((m, i) => {
		if (!(m instanceof ToolMessage) || keepWhole.has(i)) return m;
		const bytes = contentBytes(m.content);
		const marker = elisionMarker(m.name, bytes);
		const markerBytes = Buffer.byteLength(marker, "utf8");
		// Never "elide" something already smaller than its own marker.
		if (bytes <= markerBytes) return m;
		elidedCount += 1;
		freedBytes += bytes - markerBytes;
		return new ToolMessage({
			content: marker,
			tool_call_id: m.tool_call_id,
			name: m.name,
			status: m.status,
		});
	});

	return { messages: out, elidedCount, freedBytes, totalBytes };
}
