// agent/src/message-utils.test.ts
import { describe, expect, test } from "bun:test";
import { extractTextFromContent } from "./message-utils.ts";

describe("extractTextFromContent (SIO-1217)", () => {
	test("returns a plain string unchanged", () => {
		expect(extractTextFromContent("hello world")).toBe("hello world");
	});

	// Regression: Claude 4.7+/5-generation models on Bedrock Converse (adaptive thinking
	// always on) can emit AIMessage(Chunk).content as an array of content blocks instead
	// of a string. String(content) on that array produces "[object Object],[object Object]"
	// via Array.prototype.toString(). This must extract only the text blocks' text instead.
	test("extracts text from an array of content blocks, never [object Object]", () => {
		const content = [
			{ type: "text", text: "The incident root cause is a timeout." },
			{ type: "text", text: "Confidence: 0.8" },
		];
		const result = extractTextFromContent(content);
		expect(result).not.toContain("[object Object]");
		expect(result).toBe("The incident root cause is a timeout.\nConfidence: 0.8");
	});

	test("filters out thinking/reasoning blocks, keeping only text blocks", () => {
		const content = [
			{ type: "thinking", thinking: "internal reasoning the user should not see" },
			{ type: "text", text: "Visible answer." },
			{ type: "tool_use", id: "t1", name: "some_tool", input: {} },
		];
		const result = extractTextFromContent(content);
		expect(result).toBe("Visible answer.");
		expect(result).not.toContain("[object Object]");
		expect(result).not.toContain("internal reasoning");
	});

	test("handles an empty content-block array", () => {
		expect(extractTextFromContent([])).toBe("");
	});

	test("handles a single-element array without a trailing separator", () => {
		expect(extractTextFromContent([{ type: "text", text: "only block" }])).toBe("only block");
	});

	test("accepts unknown-typed input (e.g. raw LangGraph stream event content)", () => {
		// sse-pump.ts reads event.data.chunk.content, typed unknown -- the helper must
		// accept it directly without a caller-side cast.
		const raw: unknown = [{ type: "text", text: "streamed chunk" }];
		expect(extractTextFromContent(raw)).toBe("streamed chunk");
	});

	test("falls back to String() for a non-string, non-array value", () => {
		expect(extractTextFromContent(null)).toBe("null");
		expect(extractTextFromContent(undefined)).toBe("undefined");
	});
});
