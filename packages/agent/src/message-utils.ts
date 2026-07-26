// agent/src/message-utils.ts
import { getLogger } from "@devops-agent/observability";
import type { MessageContentText } from "@langchain/core/messages";
import { z } from "zod";

const logger = getLogger("agent:message-utils");

// SIO-1217: AIMessage(Chunk).content is typed string | MessageContentComplex[] --
// Bedrock Converse responses for Claude's 4.7+/5-generation models (adaptive thinking
// always on) can emit an array of content blocks (text/thinking/reasoning/tool_use)
// instead of a plain string. String(content) on that array silently produces
// "[object Object],[object Object],..." via Array.prototype.toString(). Always route
// through this helper instead of String(x.content) at any LLM-response call site.
const textBlockSchema = z
	.object({
		type: z.literal("text"),
		text: z.string(),
	})
	.passthrough();

function isTextBlock(block: unknown): block is MessageContentText {
	return textBlockSchema.safeParse(block).success;
}

// SIO-1222: non-text blocks are dropped silently, which makes an upstream shape change
// ("the provider renamed the text block type") indistinguishable from "the model returned
// nothing" -- both surface as an empty string, and every caller reads that as the latter.
// Log when we discard EVERY block of a non-empty array: that is the shape that would have
// made the SIO-1217 class of bug obvious immediately instead of via a garbled chat bubble.
function logIfAllBlocksDropped(blocks: unknown[], kept: number, fn: string): void {
	if (blocks.length === 0 || kept > 0) return;
	const types = [...new Set(blocks.map((b) => (b as { type?: unknown })?.type ?? typeof b))];
	logger.warn({ fn, blockCount: blocks.length, blockTypes: types }, "dropped every content block; returning empty");
}

// SIO-1231: text blocks are concatenated with NO separator. The original "\n" join assumed a
// complete message's blocks are "distinct logical paragraphs"; that assumption is wrong on both
// shapes this codebase actually produces:
//   1. Streamed nodes. The whole graph runs under streamEvents, so llm.invoke() never takes the
//      _generate path -- LangChain streams internally and concats the AIMessageChunks, leaving one
//      text block PER DELTA. "\n" put a newline at every delta boundary, and markdown.ts renders
//      with breaks:true, so the final report came out as "Incident Report: pr" / "ana-order-service
//      -- Se" / "asons Lookup Fail". SIO-1218 fixed the live bubble via extractStreamDeltaText and
//      explicitly left the complete-message sites alone -- but aggregate/responder ARE streamed.
//   2. Cached system prompts. buildCachedSystemMessage emits [{text: stable}, CACHE_POINT,
//      {text: volatile}] and its cache-disabled path is `stable + volatile` -- no separator. A "\n"
//      join silently broke prompt-cache.ts's own "byte-identical to the pre-cache prompt" promise.
// A model that wants a paragraph break emits "\n\n" INSIDE the block text, so "" loses nothing.
export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const texts = content.filter(isTextBlock).map((block) => block.text);
		logIfAllBlocksDropped(content, texts.length, "extractTextFromContent");
		return texts.join("");
	}
	// A single content block (not wrapped in an array) or any other unsupported shape --
	// String(content) here would reproduce the exact "[object Object]" bug this helper
	// exists to prevent. Extract text from a lone text block; otherwise empty string.
	return isTextBlock(content) ? content.text : "";
}

// SIO-1233: the block TYPES present on a response, for diagnosing an empty text extraction.
// Sonnet 5 emits reasoning blocks stochastically (MODEL_REGISTRY emitsReasoningContent, whose
// own doc warns that `false` means "not seen in that run", never "cannot happen"), so a turn
// can come back reasoning-only. extractTextFromContent then returns "" and a caller reads that
// as "the model said nothing" -- which at entityExtractor means falling back to all 7
// datasources. Logging the observed types distinguishes "reasoning-only turn" from "provider
// renamed the text block" from "genuinely empty", which are three different bugs.
// Type names only; block CONTENT is never returned.
export function contentBlockTypes(content: unknown): string[] {
	if (typeof content === "string") return ["string"];
	const blocks = Array.isArray(content) ? content : [content];
	return [...new Set(blocks.map((b) => (b as { type?: unknown })?.type ?? typeof b).map(String))];
}

// SIO-1218: sse-pump.ts calls this per streamed AIMessageChunk delta rather than on a complete
// message. When one delta chunk carries more than one array block (Bedrock Converse can batch
// adjacent text deltas under the 4.7+/5-generation models' adaptive thinking), a separator would
// splice into the middle of a word and garble the live-streamed bubble.
// SIO-1231: this now has the SAME join semantics as extractTextFromContent -- the two are kept
// separate only for the instrumentation difference documented below, NOT for a different join.
// If you are choosing between them: use this one on a per-delta chunk, the other on a complete
// message. Picking the wrong one is no longer a correctness bug, only a logging one.
// SIO-1222: deliberately NOT instrumented like extractTextFromContent. This runs once per
// streamed delta (thousands of times per turn), and a chunk legitimately carrying no text
// block is routine, not a signal -- logging here would be pure noise. The complete-message
// path is where an all-blocks-dropped result actually means something.
export function extractStreamDeltaText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(isTextBlock)
			.map((block) => block.text)
			.join("");
	}
	return isTextBlock(content) ? content.text : "";
}
