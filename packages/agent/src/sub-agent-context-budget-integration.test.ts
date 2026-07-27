// agent/src/sub-agent-context-budget-integration.test.ts
//
// SIO-1250: the unit tests prove applyContextBudget is correct in isolation. This
// one proves the WIRING: that createReactAgent's preModelHook actually swaps in
// llmInputMessages, that the model really receives the elided view, and -- the
// part that matters most -- that canonical `messages` is left whole so
// extractToolErrors and the SIO-1248 raw capture keep seeing everything.

import { describe, expect, test } from "bun:test";
import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { applyContextBudget } from "./sub-agent-context-budget.ts";

const BUDGET = 25_000;
const RESULT_BYTES = 10_000;
const ROUNDS = 4;

function seededHistory(): BaseMessage[] {
	const history: BaseMessage[] = [new HumanMessage("investigate")];
	for (let i = 0; i < ROUNDS; i += 1) {
		history.push(new AIMessage({ content: "", tool_calls: [{ id: `c${i}`, name: "elasticsearch_search", args: {} }] }));
		history.push(
			new ToolMessage({ content: "x".repeat(RESULT_BYTES), tool_call_id: `c${i}`, name: "elasticsearch_search" }),
		);
	}
	return history;
}

describe("SIO-1250 preModelHook wiring", () => {
	test("model sees the budgeted view while canonical messages stay whole", async () => {
		// Capture the model's real input via a callback rather than subclassing, so the
		// assertion rides the same path production does and needs no `any`.
		let seen: BaseMessage[] = [];
		const capture = {
			handleChatModelStart: (_llm: unknown, messages: BaseMessage[][]) => {
				seen = messages[0] ?? [];
			},
		};

		const llm = new FakeListChatModel({ responses: ["done"] });
		const noop = tool(async () => "ok", {
			name: "elasticsearch_search",
			description: "x",
			schema: z.object({}),
		});

		const agent = createReactAgent({
			llm: llm as never,
			tools: [noop],
			preModelHook: (state: { messages: BaseMessage[] }) =>
				({ llmInputMessages: applyContextBudget(state.messages, BUDGET).messages }) as never,
		});

		const result = await agent.invoke({ messages: seededHistory() }, { callbacks: [capture] });

		// 1. The model received an elided view, bounded by the budget.
		const seenTools = seen.filter((m): m is ToolMessage => m instanceof ToolMessage);
		expect(seenTools.length).toBe(ROUNDS);
		const seenBytes = seenTools.reduce((s, m) => s + String(m.content).length, 0);
		expect(seenBytes).toBeLessThan(ROUNDS * RESULT_BYTES); // strictly smaller than unbounded
		expect(seenBytes).toBeLessThanOrEqual(BUDGET + 1000); // markers add a little back
		expect(seenTools.filter((m) => String(m.content).includes("elided")).length).toBeGreaterThan(0);

		// 2. Pairing intact in what the model saw -- no orphaned tool result.
		const seenCallIds = new Set(
			seen.flatMap((m) => (m instanceof AIMessage ? (m.tool_calls ?? []).map((t) => t.id) : [])),
		);
		for (const m of seenTools) expect(seenCallIds.has(m.tool_call_id)).toBe(true);

		// 3. Canonical state is NOT mutated -- every original payload survives at full size.
		const canonical = (result.messages as BaseMessage[]).filter((m): m is ToolMessage => m instanceof ToolMessage);
		expect(canonical).toHaveLength(ROUNDS);
		for (const m of canonical) {
			expect(String(m.content)).toHaveLength(RESULT_BYTES);
		}
	});
});
