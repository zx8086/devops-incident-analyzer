// agent/src/sub-agent-context-budget.test.ts

import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { applyContextBudget, getSubAgentContextBudgetBytes } from "./sub-agent-context-budget.ts";

function toolResult(id: string, name: string, bytes: number): ToolMessage {
	return new ToolMessage({ content: "x".repeat(bytes), tool_call_id: id, name });
}

function aiWithCalls(...ids: string[]): AIMessage {
	return new AIMessage({
		content: "",
		tool_calls: ids.map((id) => ({ id, name: "elasticsearch_search", args: {} })),
	});
}

// A realistic loop: system + human, then N (AIMessage -> ToolMessage) rounds.
function buildLoop(sizes: number[]): (AIMessage | ToolMessage | SystemMessage | HumanMessage)[] {
	const out: (AIMessage | ToolMessage | SystemMessage | HumanMessage)[] = [
		new SystemMessage("system prompt"),
		new HumanMessage("investigate"),
	];
	sizes.forEach((bytes, i) => {
		out.push(aiWithCalls(`call_${i}`));
		out.push(toolResult(`call_${i}`, "elasticsearch_search", bytes));
	});
	return out;
}

describe("getSubAgentContextBudgetBytes", () => {
	test("defaults when unset, disables on explicit 0, honours override", () => {
		expect(getSubAgentContextBudgetBytes({} as NodeJS.ProcessEnv)).toBeGreaterThan(0);
		expect(getSubAgentContextBudgetBytes({ SUBAGENT_CONTEXT_BUDGET_BYTES: "" } as never)).toBeGreaterThan(0);
		expect(getSubAgentContextBudgetBytes({ SUBAGENT_CONTEXT_BUDGET_BYTES: "0" } as never)).toBeNull();
		expect(getSubAgentContextBudgetBytes({ SUBAGENT_CONTEXT_BUDGET_BYTES: "50000" } as never)).toBe(50_000);
		// invalid / negative fall back to the default rather than disabling
		expect(getSubAgentContextBudgetBytes({ SUBAGENT_CONTEXT_BUDGET_BYTES: "abc" } as never)).toBeGreaterThan(0);
		expect(getSubAgentContextBudgetBytes({ SUBAGENT_CONTEXT_BUDGET_BYTES: "-5" } as never)).toBeGreaterThan(0);
	});
});

describe("applyContextBudget", () => {
	test("is a no-op when total tool content fits the budget", () => {
		const messages = buildLoop([1000, 1000, 1000]);
		const result = applyContextBudget(messages, 100_000);

		expect(result.elidedCount).toBe(0);
		expect(result.messages).toEqual(messages);
	});

	test("elides the OLDEST tool results and keeps the newest intact", () => {
		// 4 results of 10KB each = 40KB; budget 25KB keeps the newest 2.
		const messages = buildLoop([10_000, 10_000, 10_000, 10_000]);
		const result = applyContextBudget(messages, 25_000);

		const tools = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
		expect(tools).toHaveLength(4);

		// newest two survive at full size
		expect(String(tools[3]?.content)).toHaveLength(10_000);
		expect(String(tools[2]?.content)).toHaveLength(10_000);
		// oldest two are elided down to a short marker
		expect(String(tools[0]?.content)).toMatch(/elided/i);
		expect(String(tools[1]?.content)).toMatch(/elided/i);
		expect(String(tools[0]?.content).length).toBeLessThan(300);
		expect(result.elidedCount).toBe(2);
		expect(result.freedBytes).toBeGreaterThan(19_000);
	});

	test("NEVER removes a message, so tool_call pairing can never break", () => {
		const messages = buildLoop([50_000, 50_000, 50_000]);
		const result = applyContextBudget(messages, 10_000);

		// same length, same order, same classes
		expect(result.messages).toHaveLength(messages.length);
		result.messages.forEach((m, i) => {
			expect(m.constructor.name).toBe(String(messages[i]?.constructor.name));
		});

		// every ToolMessage still pairs with an AIMessage tool_call id
		const callIds = new Set(
			result.messages.flatMap((m) => (m instanceof AIMessage ? (m.tool_calls ?? []).map((t) => t.id) : [])),
		);
		for (const m of result.messages) {
			if (m instanceof ToolMessage) expect(callIds.has(m.tool_call_id)).toBe(true);
		}
	});

	test("preserves tool_call_id and name on elided messages", () => {
		const messages = buildLoop([40_000, 40_000]);
		const result = applyContextBudget(messages, 10_000);

		const elided = result.messages.find(
			(m): m is ToolMessage => m instanceof ToolMessage && String(m.content).includes("elided"),
		);
		expect(elided?.tool_call_id).toBe("call_0");
		expect(elided?.name).toBe("elasticsearch_search");
	});

	test("keeps the newest result even when it alone exceeds the budget", () => {
		// The per-result cap (SUBAGENT_TOOL_RESULT_CAP_BYTES) already bounds a single
		// payload; eliding the only fresh result would leave the model nothing to reason on.
		const messages = buildLoop([5_000, 80_000]);
		const result = applyContextBudget(messages, 1_000);

		const tools = result.messages.filter((m): m is ToolMessage => m instanceof ToolMessage);
		expect(String(tools[1]?.content)).toHaveLength(80_000);
		expect(String(tools[0]?.content)).toMatch(/elided/i);
	});

	test("bounds the surviving tool content for an unbounded loop (the SIO-1250 guarantee)", () => {
		// 40 results at the 131_072 per-result cap -- the shape that overflowed 200k.
		const messages = buildLoop(Array.from({ length: 40 }, () => 131_072));
		const budget = 400_000;
		const result = applyContextBudget(messages, budget);

		const surviving = result.messages
			.filter((m): m is ToolMessage => m instanceof ToolMessage)
			.reduce((sum, m) => sum + Buffer.byteLength(String(m.content), "utf8"), 0);

		// Bounded by budget + one over-hang result + the small markers.
		expect(surviving).toBeLessThan(budget + 131_072 + 40 * 300);
		expect(result.elidedCount).toBeGreaterThan(30);
	});

	test("leaves non-tool messages untouched", () => {
		const messages = buildLoop([40_000, 40_000]);
		const result = applyContextBudget(messages, 1_000);

		expect(result.messages[0]).toBeInstanceOf(SystemMessage);
		expect(String(result.messages[0]?.content)).toBe("system prompt");
		expect(String(result.messages[1]?.content)).toBe("investigate");
	});
});
