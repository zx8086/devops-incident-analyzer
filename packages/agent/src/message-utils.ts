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

export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const texts = content.filter(isTextBlock).map((block) => block.text);
		logIfAllBlocksDropped(content, texts.length, "extractTextFromContent");
		return texts.join("\n");
	}
	// A single content block (not wrapped in an array) or any other unsupported shape --
	// String(content) here would reproduce the exact "[object Object]" bug this helper
	// exists to prevent. Extract text from a lone text block; otherwise empty string.
	return isTextBlock(content) ? content.text : "";
}

// SIO-1218: extractTextFromContent's "\n" join is correct for a COMPLETE message's
// distinct logical content blocks, but sse-pump.ts calls it per streamed AIMessageChunk
// delta instead. When one delta chunk carries more than one array block (Bedrock Converse
// can batch adjacent text deltas under the 4.7+/5-generation models' adaptive thinking),
// the "\n" join splices a newline into the middle of a word, garbling the live-streamed
// bubble. A streaming delta's blocks are contiguous text fragments, not separate
// paragraphs -- concatenate them directly.
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
