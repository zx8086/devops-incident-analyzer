// agent/src/prompt-cache.test.ts
import { describe, expect, test } from "bun:test";
import { SystemMessage } from "@langchain/core/messages";
import { buildCachedSystemMessage, CACHE_POINT, isPromptCacheEnabled } from "./prompt-cache.ts";

describe("isPromptCacheEnabled (SIO-1040)", () => {
	test("defaults ON when the flag is unset", () => {
		expect(isPromptCacheEnabled({})).toBe(true);
	});

	test("stays ON for any value other than the literal 'false'", () => {
		expect(isPromptCacheEnabled({ AGENT_PROMPT_CACHE_ENABLED: "true" })).toBe(true);
		expect(isPromptCacheEnabled({ AGENT_PROMPT_CACHE_ENABLED: "1" })).toBe(true);
		expect(isPromptCacheEnabled({ AGENT_PROMPT_CACHE_ENABLED: "" })).toBe(true);
	});

	test("kill-switch: only the literal 'false' disables it", () => {
		expect(isPromptCacheEnabled({ AGENT_PROMPT_CACHE_ENABLED: "false" })).toBe(false);
	});
});

describe("buildCachedSystemMessage (SIO-1040)", () => {
	test("enabled with volatile: [text, cachePoint, text] blocks", () => {
		const msg = buildCachedSystemMessage("STABLE", "VOLATILE", { AGENT_PROMPT_CACHE_ENABLED: "true" });
		expect(msg).toBeInstanceOf(SystemMessage);
		expect(Array.isArray(msg.content)).toBe(true);
		expect(msg.content as unknown[]).toEqual([
			{ type: "text", text: "STABLE" },
			CACHE_POINT,
			{ type: "text", text: "VOLATILE" },
		]);
	});

	test("enabled with empty volatile: cache point is still the last block (no empty text block)", () => {
		// The 1.3.x converter rejects empty text blocks -> a "" volatile must be dropped.
		const msg = buildCachedSystemMessage("STABLE", "", { AGENT_PROMPT_CACHE_ENABLED: "true" });
		expect(msg.content as unknown[]).toEqual([{ type: "text", text: "STABLE" }, CACHE_POINT]);
	});

	test("enabled with whitespace-only volatile: dropped like empty", () => {
		const msg = buildCachedSystemMessage("STABLE", "   \n  ", { AGENT_PROMPT_CACHE_ENABLED: "true" });
		expect(msg.content as unknown[]).toEqual([{ type: "text", text: "STABLE" }, CACHE_POINT]);
	});

	test("kill-switch: falls back to a plain string SystemMessage of stable + volatile", () => {
		const msg = buildCachedSystemMessage("STABLE", "VOLATILE", { AGENT_PROMPT_CACHE_ENABLED: "false" });
		expect(msg).toBeInstanceOf(SystemMessage);
		expect(msg.content).toBe("STABLEVOLATILE");
	});

	test("kill-switch fallback concatenation is byte-identical to the pre-cache prompt", () => {
		const stable = "core-prefix\n\n---\n\n";
		const volatile = "volatile-suffix";
		const msg = buildCachedSystemMessage(stable, volatile, { AGENT_PROMPT_CACHE_ENABLED: "false" });
		expect(msg.content).toBe(stable + volatile);
	});
});
