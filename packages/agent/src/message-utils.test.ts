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

	test("returns empty string for null/undefined instead of stringifying", () => {
		expect(extractTextFromContent(null)).toBe("");
		expect(extractTextFromContent(undefined)).toBe("");
	});

	// Regression for CodeRabbit comment_id=3652123185: a single content block not
	// wrapped in an array, or any other unsupported object shape, must never fall
	// through to String(content) -- that reproduces the exact "[object Object]" bug.
	test("returns empty string for an unsupported object shape, never [object Object]", () => {
		expect(extractTextFromContent({ foo: "bar" })).toBe("");
		expect(extractTextFromContent(42)).toBe("");
	});

	test("extracts text from a single content block not wrapped in an array", () => {
		expect(extractTextFromContent({ type: "text", text: "lone block" })).toBe("lone block");
	});
});
