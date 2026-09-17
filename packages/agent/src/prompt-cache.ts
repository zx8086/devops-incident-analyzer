// agent/src/prompt-cache.ts
import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	type MessageContent,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";

// SIO-1040: Bedrock prompt caching. A "cache point" content block marks the end
// of a cacheable prefix. @langchain/aws forwards { cachePoint: { type: "default" } }
// straight to the Converse API (convertSystemMessageToConverseMessage accepts
// text blocks plus this exact cache-point shape and throws on anything else).
// @langchain/core's ContentBlock union does not model the provider-specific
// cache-point block, so we type our blocks locally and narrow at the constructor.
export const CACHE_POINT = { cachePoint: { type: "default" } } as const;

type TextBlock = { type: "text"; text: string };
type SystemContentBlock = TextBlock | typeof CACHE_POINT;

// Default ON; the env var is a kill-switch so ops can disable caching without a
// deploy if a Bedrock ValidationException or cost regression shows up in traces.
export function isPromptCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.AGENT_PROMPT_CACHE_ENABLED !== "false";
}

// Build a SystemMessage that caches `stable` (the turn-invariant prefix) while
// leaving `volatile` (live memory, wiki, graph, per-turn scope notes) outside the
// cache. When disabled, returns a plain string SystemMessage of stable + volatile
// so behaviour is byte-identical to the pre-cache prompt.
export function buildCachedSystemMessage(
	stable: string,
	volatile: string,
	env: NodeJS.ProcessEnv = process.env,
): SystemMessage {
	if (!isPromptCacheEnabled(env)) return new SystemMessage(stable + volatile);

	const content: SystemContentBlock[] = [{ type: "text", text: stable }, CACHE_POINT];
	// Bedrock rejects empty text content blocks at request time; a blank volatile must be dropped.
	if (volatile.trim() !== "") content.push({ type: "text", text: volatile });

	// SDK lags runtime: core's ContentBlock union omits the provider cache-point
	// block that @langchain/aws requires. Narrow through unknown at this boundary.
	return new SystemMessage({ content: content as unknown as MessageContent });
}

// SIO-1773: the system-prompt cache point above covers only the turn-invariant prefix.
// A sub-agent's cost is its tool-result history, which a ReAct loop re-sends in full on
// every turn: on run f77ce7dd cacheReadTokens stayed flat at the system-prompt size while
// per-turn input climbed past 100k. Marking the end of the history lets each turn read
// the previous turns from cache and pay only for what is new.
//
// TWO points, not one: the newest message, and the message that closed the previous
// round (just before the latest AIMessage). The second is exactly where the last turn's
// cache write landed, so the read is a guaranteed prefix match rather than relying on
// Bedrock's bounded look-back, which a wide parallel tool round could exceed. With the
// system point that is 3 of Bedrock's 4.
//
// Pure: returns new message instances for the tagged slots and never mutates its input,
// because preModelHook hands this to `llmInputMessages` and canonical `messages` must
// stay byte-identical for the extractors and the SIO-1248 raw capture.
export function withRollingCachePoints(messages: BaseMessage[], env: NodeJS.ProcessEnv = process.env): BaseMessage[] {
	if (!isPromptCacheEnabled(env) || messages.length === 0) return messages;
	const targets = new Set<number>([messages.length - 1]);
	for (let i = messages.length - 1; i > 0; i -= 1) {
		if (messages[i] instanceof AIMessage) {
			targets.add(i - 1);
			break;
		}
	}
	return messages.map((m, i) => (targets.has(i) ? tagged(m) : m));
}

function tagged(m: BaseMessage): BaseMessage {
	// Only tool results and user turns: @langchain/aws hoists a cache point out of a
	// ToolMessage's content to sit beside the toolResult block, and passes it through in a
	// HumanMessage. A SystemMessage already carries its own point.
	if (!(m instanceof ToolMessage) && !(m instanceof HumanMessage)) return m;
	const blocks: unknown[] =
		typeof m.content === "string" ? (m.content === "" ? [] : [{ type: "text", text: m.content }]) : [...m.content];
	// Bedrock rejects empty text blocks, and a lone cache point is not valid content.
	if (blocks.length === 0 || blocks.some((b) => typeof b === "object" && b !== null && "cachePoint" in b)) return m;
	const content = [...blocks, CACHE_POINT] as unknown as MessageContent;
	return m instanceof ToolMessage
		? new ToolMessage({
				content,
				tool_call_id: m.tool_call_id,
				name: m.name,
				status: m.status,
				artifact: m.artifact,
				id: m.id,
			})
		: new HumanMessage({ content, id: m.id });
}
