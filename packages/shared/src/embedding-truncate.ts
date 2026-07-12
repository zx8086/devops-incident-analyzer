// shared/src/embedding-truncate.ts

// SIO-1081: cap text before it reaches a Bedrock Titan v2 embedder. Both embed
// entry points (the graphEnrich client-side embed and the agent-memory recall
// query the service embeds server-side) fed the full, unbounded user message and
// blew past the limit on large pasted incidents.
//
// Titan v2 enforces BOTH an 8192-token AND a 50000-character hard limit, and does
// not auto-truncate. AWS's English heuristic is ~4.7 chars/token, but token-dense
// content (code, JSON, stack traces -- exactly the pasted-log case here) runs
// closer to ~3 chars/token. 8192 tokens x 3 chars ~= 24576, so a 24000-char cap
// stays under BOTH limits even for the densest realistic input, without pulling in
// a tokenizer dependency. Head-truncation is intentional: for similarity seeding a
// pasted log's leading frames (the exception + first stack frames) carry the signal.
const DEFAULT_EMBED_MAX_CHARS = 24_000;

// Env reader mirroring getSubAgentToolCapBytes' contract: unset/invalid -> default,
// "0" -> disabled (no cap, returns null), otherwise a positive floored cap. Read
// inside the function (never module scope) so tests and hot-reload see current env.
// A trimmed, non-finite, negative, or sub-1 effective cap all fall back to the
// default so a malformed value can never collapse embeddings to zero length.
export function embeddingMaxChars(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env.EMBEDDINGS_MAX_CHARS?.trim();
	if (raw == null || raw === "") return DEFAULT_EMBED_MAX_CHARS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_EMBED_MAX_CHARS;
	if (parsed === 0) return null; // explicit "0" disables the cap
	const floored = Math.floor(parsed);
	if (floored < 1) return DEFAULT_EMBED_MAX_CHARS; // e.g. "0.5" -> would zero-length input
	return floored;
}

// Head-truncate text to maxChars. maxChars defaults to embeddingMaxChars(); null
// disables truncation (passthrough). Returns the input unchanged when already
// within the cap, so callers can wrap every embed input unconditionally. A
// non-finite or negative explicit cap is treated as "no cap" rather than silently
// slicing, so a direct caller can never corrupt embedding input to "".
export function truncateForEmbedding(text: string, maxChars: number | null = embeddingMaxChars()): string {
	if (maxChars == null || !Number.isFinite(maxChars) || maxChars < 0) return text;
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars);
}
