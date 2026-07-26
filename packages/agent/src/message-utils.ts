// agent/src/message-utils.ts
import type { MessageContentText } from "@langchain/core/messages";
import { z } from "zod";

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

export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(isTextBlock)
			.map((block) => block.text)
			.join("\n");
	}
	// A single content block (not wrapped in an array) or any other unsupported shape --
	// String(content) here would reproduce the exact "[object Object]" bug this helper
	// exists to prevent. Extract text from a lone text block; otherwise empty string.
	return isTextBlock(content) ? content.text : "";
}
