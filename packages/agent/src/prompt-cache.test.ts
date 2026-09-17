// agent/src/prompt-cache.test.ts
import { describe, expect, test } from "bun:test";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { buildCachedSystemMessage, CACHE_POINT, isPromptCacheEnabled, withRollingCachePoints } from "./prompt-cache.ts";

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
		// Bedrock rejects empty text content blocks at request time -> a "" volatile must be dropped.
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

describe("withRollingCachePoints (SIO-1773)", () => {
	const ON = {} as NodeJS.ProcessEnv;
	const hasPoint = (m: BaseMessage) =>
		Array.isArray(m.content) && m.content.some((b) => typeof b === "object" && b !== null && "cachePoint" in b);
	const call = (id: string) =>
		new AIMessage({ content: "", tool_calls: [{ id, name: "t", args: {}, type: "tool_call" }] });
	const result = (id: string, content = "rows") => new ToolMessage({ content, tool_call_id: id, name: "t" });

	test("first turn: only the user message is tagged", () => {
		const out = withRollingCachePoints([new HumanMessage("why is it failing?")], ON);
		expect(out.map(hasPoint)).toEqual([true]);
		expect(out[0]?.content as unknown).toEqual([{ type: "text", text: "why is it failing?" }, CACHE_POINT]);
	});

	test("later turn: tags the newest message and the one that closed the previous round", () => {
		const msgs = [new HumanMessage("q"), call("a"), result("a"), call("b"), result("b1"), result("b2")];
		// index 2 closed the previous round (it precedes the latest AIMessage); index 5 is newest.
		expect(withRollingCachePoints(msgs, ON).map(hasPoint)).toEqual([false, false, true, false, false, true]);
	});

	test("never mutates its input, and keeps tool-call pairing fields", () => {
		const original = result("a", "payload");
		const msgs = [new HumanMessage("q"), call("a"), original];
		const out = withRollingCachePoints(msgs, ON);
		expect(original.content).toBe("payload");
		expect(msgs[2]).toBe(original);
		const tagged = out[2] as ToolMessage;
		expect(tagged).not.toBe(original);
		expect(tagged.tool_call_id).toBe("a");
		expect(tagged.name).toBe("t");
	});

	test("skips empty content (Bedrock rejects empty text blocks) and already-tagged content", () => {
		const empty = withRollingCachePoints([new HumanMessage("q"), call("a"), result("a", "")], ON);
		expect(hasPoint(empty[2] as BaseMessage)).toBe(false);
		const once = withRollingCachePoints([new HumanMessage("q")], ON);
		const twice = withRollingCachePoints(once, ON);
		const blocks = (twice[0]?.content ?? []) as unknown[];
		expect(blocks.filter((b) => typeof b === "object" && b !== null && "cachePoint" in b)).toHaveLength(1);
	});

	test("kill-switch returns the input untouched", () => {
		const msgs = [new HumanMessage("q")];
		expect(withRollingCachePoints(msgs, { AGENT_PROMPT_CACHE_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(msgs);
	});

	// Certifies the library assumption the helper rests on, against the REAL converter:
	// a cache point inside ToolMessage content must come out BESIDE the toolResult block
	// (Bedrock rejects it inside), and the request must stay within 4 cache points.
	// Imported by file path on purpose: a dozen test files mock.module("@langchain/aws")
	// and bun leaks that process-wide, so the package specifier is not the real library
	// in a full run. If a future version moves this file the import fails loudly, which
	// is the prompt to re-verify the assumption.
	test("@langchain/aws puts the points beside toolResult, 3 in total with the system point", async () => {
		// A variable specifier: the file ships no .d.ts, and the cast below types it.
		const converterPath = "../node_modules/@langchain/aws/dist/utils/message_inputs.js";
		const { convertToConverseMessages } = (await import(converterPath)) as {
			convertToConverseMessages: (m: BaseMessage[]) => {
				converseMessages: Array<{ role: string; content: unknown[] }>;
				converseSystem: unknown[];
			};
		};
		const history = [new HumanMessage("q"), call("a"), result("a", "first rows"), call("b"), result("b", "more rows")];
		const { converseMessages, converseSystem } = convertToConverseMessages([
			buildCachedSystemMessage("stable", "volatile", ON),
			...withRollingCachePoints(history, ON),
		]);

		const isPoint = (b: unknown) => typeof b === "object" && b !== null && "cachePoint" in b;
		const userTurns = converseMessages.filter((m) => m.role === "user");
		const lastTurn = userTurns[userTurns.length - 1]?.content ?? [];
		expect(Object.keys(lastTurn[0] as object)).toEqual(["toolResult"]);
		expect(isPoint(lastTurn[1])).toBe(true);
		expect(JSON.stringify((lastTurn[0] as { toolResult: unknown }).toolResult)).not.toContain("cachePoint");
		const total =
			converseSystem.filter(isPoint).length + converseMessages.flatMap((m) => m.content).filter(isPoint).length;
		expect(total).toBe(3);
	});
});
