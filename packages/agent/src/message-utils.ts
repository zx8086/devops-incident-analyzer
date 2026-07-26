// agent/src/message-utils.ts
import type { MessageContentText } from "@langchain/core/messages";

// SIO-1217: AIMessage(Chunk).content is typed string | MessageContentComplex[] --
// Bedrock Converse responses for Claude's 4.7+/5-generation models (adaptive thinking
// always on) can emit an array of content blocks (text/thinking/reasoning/tool_use)
// instead of a plain string. String(content) on that array silently produces
// "[object Object],[object Object],..." via Array.prototype.toString(). Always route
// through this helper instead of String(x.content) at any LLM-response call site.
export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content);
	return (content as unknown[])
		.filter(
			(block): block is MessageContentText =>
				block !== null &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}
