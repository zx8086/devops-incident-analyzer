// agent/src/message-utils.ts
import type { MessageContentComplex, MessageContentText } from "@langchain/core/messages";

type MessageContent = string | MessageContentComplex[];

export function extractTextFromContent(content: MessageContent): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content);
	return content
		.filter(
			(block): block is MessageContentText => typeof block === "object" && "type" in block && block.type === "text",
		)
		.map((block) => block.text)
		.join("\n");
}
