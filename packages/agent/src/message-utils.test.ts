// agent/src/message-utils.test.ts
import { describe, expect, test } from "bun:test";
import { extractStreamDeltaText, extractTextFromContent } from "./message-utils.ts";

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
			{ type: "text", text: "The incident root cause is a timeout.\n" },
			{ type: "text", text: "Confidence: 0.8" },
		];
		const result = extractTextFromContent(content);
		expect(result).not.toContain("[object Object]");
		// SIO-1231: blocks concatenate with NO separator. This assertion previously expected an
		// injected "\n" between the blocks; a model that wants a break emits it inside the text,
		// as the first block does here.
		expect(result).toBe("The incident root cause is a timeout.\nConfidence: 0.8");
	});

	// SIO-1231 regression. The whole graph runs under streamEvents, so llm.invoke() at the
	// aggregate/responder OUTPUT_NODES returns LangChain's concatenation of the AIMessageChunks --
	// one text block PER DELTA, not per paragraph. A "\n" join put a newline at every delta
	// boundary and markdown.ts (breaks: true) rendered each as a <br>, producing the reported
	// "Incident Report: pr" / "ana-order-service -- Se" / "asons Lookup Fail" garbling.
	test("concatenates delta-shaped blocks of a complete message with no injected separator", () => {
		const content = [
			{ type: "text", text: "# Incident Report: pr" },
			{ type: "text", text: "ana-order-service -- Se" },
			{ type: "text", text: "asons Lookup Fail" },
			{ type: "text", text: "ure (CK / DIVISIONAL + OUTLET)" },
		];
		const result = extractTextFromContent(content);
		expect(result).toBe("# Incident Report: prana-order-service -- Seasons Lookup Failure (CK / DIVISIONAL + OUTLET)");
		expect(result).not.toContain("\n");
	});

	// SIO-1231: the second shape the "\n" join broke. buildCachedSystemMessage emits
	// [{text: stable}, CACHE_POINT, {text: volatile}] and its cache-DISABLED path is
	// `stable + volatile` with no separator, so reconstructing the cached form must produce the
	// identical string -- that is prompt-cache.ts's stated "byte-identical to the pre-cache
	// prompt" guarantee.
	test("reconstructs a cachePoint system prompt identically to the uncached concatenation", () => {
		const stable = "You are the aggregator.\n";
		const volatile = "Live memory: none.\n";
		const cached = [
			{ type: "text", text: stable },
			{ cachePoint: { type: "default" } },
			{ type: "text", text: volatile },
		];
		expect(extractTextFromContent(cached)).toBe(stable + volatile);
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

describe("extractStreamDeltaText (SIO-1218)", () => {
	// Regression: sse-pump.ts calls extractTextFromContent on each streamed
	// AIMessageChunk.content delta, not a complete message. When a single delta
	// chunk carries more than one array block (Bedrock Converse batches adjacent
	// text deltas under the 4.7+/5-generation models' always-on adaptive thinking),
	// a separator splices a newline into the middle of a word, visibly garbling the
	// live-streamed bubble (e.g. "Se\nasons" instead of "Seasons").
	// SIO-1231: the "\n" this originally guarded against is gone from BOTH helpers --
	// it was never correct for a complete message either (see the two regressions above).
	// These tests still pin the no-separator contract for the per-delta path.
	test("concatenates same-chunk delta blocks with no separator, never mid-word newline", () => {
		const chunk = [
			{ type: "text", text: "ana-order-service -- Se" },
			{ type: "text", text: "asons API" },
		];
		const result = extractStreamDeltaText(chunk);
		expect(result).toBe("ana-order-service -- Seasons API");
		expect(result).not.toContain("\n");
	});

	test("reconstructs a full sentence across multiple streamed chunks with no injected separators", () => {
		const chunks = [
			[{ type: "text", text: "Inc" }],
			[{ type: "text", text: "ident Report: pr" }],
			[
				{ type: "text", text: "ana-order-service -- Se" },
				{ type: "text", text: "asons API" },
			],
		];
		const acc = chunks.map(extractStreamDeltaText).join("");
		expect(acc).toBe("Incident Report: prana-order-service -- Seasons API");
	});

	test("still filters non-text blocks and handles a plain string chunk", () => {
		expect(extractStreamDeltaText("plain delta")).toBe("plain delta");
		expect(
			extractStreamDeltaText([
				{ type: "thinking", thinking: "internal" },
				{ type: "text", text: "visible" },
			]),
		).toBe("visible");
	});

	test("returns empty string for unsupported shapes, never [object Object]", () => {
		expect(extractStreamDeltaText(null)).toBe("");
		expect(extractStreamDeltaText({ foo: "bar" })).toBe("");
	});
});
