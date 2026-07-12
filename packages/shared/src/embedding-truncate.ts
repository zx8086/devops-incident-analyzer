// shared/src/embedding-truncate.ts
//
// SIO-1081: cap text before it reaches a Bedrock Titan v2 embedder, which hard-
// caps input at 8192 tokens. Both embed entry points (the graphEnrich client-side
// embed and the agent-memory recall query the service embeds server-side) fed the
// full, unbounded user message and blew past the limit on large pasted incidents.
//
// Head-truncation is intentional: for similarity seeding a pasted log's leading
// frames (the exception + first stack frames) carry the discriminating signal.

// Default char cap. Titan v2 = 8192 tokens ~= ~32k chars (English ~4 chars/token);
// 30000 leaves headroom for token-denser text.
const DEFAULT_EMBED_MAX_CHARS = 30_000;

// Env reader mirroring getSubAgentToolCapBytes' contract: unset/invalid -> default,
// "0" -> disabled (no cap, returns null), negative -> default. Read inside the
// function (never module scope) so tests and hot-reload see current env.
export function embeddingMaxChars(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env.EMBEDDINGS_MAX_CHARS;
	if (raw == null || raw === "") return DEFAULT_EMBED_MAX_CHARS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_EMBED_MAX_CHARS;
	if (parsed === 0) return null;
	if (parsed < 0) return DEFAULT_EMBED_MAX_CHARS;
	return Math.floor(parsed);
}

// Head-truncate text to maxChars. maxChars defaults to embeddingMaxChars(); null
// disables truncation (passthrough). Returns the input unchanged when already
// within the cap, so callers can wrap every embed input unconditionally.
export function truncateForEmbedding(text: string, maxChars: number | null = embeddingMaxChars()): string {
	if (maxChars == null || text.length <= maxChars) return text;
	return text.slice(0, maxChars);
}
