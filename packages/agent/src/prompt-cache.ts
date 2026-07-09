// agent/src/prompt-cache.ts
import { type MessageContent, SystemMessage } from "@langchain/core/messages";

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
	// The 1.3.x converter rejects empty text blocks; a blank volatile must be dropped.
	if (volatile.trim() !== "") content.push({ type: "text", text: volatile });

	// SDK lags runtime: core's ContentBlock union omits the provider cache-point
	// block that @langchain/aws requires. Narrow through unknown at this boundary.
	return new SystemMessage({ content: content as unknown as MessageContent });
}
