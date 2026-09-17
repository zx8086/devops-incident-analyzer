// agent/src/sub-agent-force-final-turn.test.ts
import { describe, expect, test } from "bun:test";
import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { shouldForceFinalTurn } from "./sub-agent.ts";
import { instrumentTools } from "./sub-agent-instrumentation.ts";
import { LOOP_GUARD_STOP_MARKER } from "./sub-agent-loop-guard.ts";

const call = (id: string) =>
	new AIMessage({ content: "", tool_calls: [{ id, name: "t", args: {}, type: "tool_call" }] });
const real = (id: string) => new ToolMessage({ content: '{"rows":[1]}', tool_call_id: id, name: "t" });
const stop = (id: string) =>
	new ToolMessage({
		content: "whatever the wording",
		tool_call_id: id,
		additional_kwargs: { [LOOP_GUARD_STOP_MARKER]: true },
	});
// ToolNode's exact unknown-tool message: status "error" plus this content.
const unbound = (id: string) =>
	new ToolMessage({
		status: "error",
		content: 'Error: Tool "gitlab_get_commit_diff" not found.\n Please fix your mistakes.',
		tool_call_id: id,
	});

const q = new HumanMessage("investigate");

describe("shouldForceFinalTurn (SIO-1779)", () => {
	test("three rounds of nothing but refusals forces the write-up", () => {
		const msgs: BaseMessage[] = [
			q,
			call("a"),
			real("a"),
			call("b"),
			stop("b"),
			call("c"),
			stop("c"),
			call("d"),
			stop("d"),
		];
		expect(shouldForceFinalTurn(msgs)).toBe(true);
	});

	test("unbound-tool errors count, and mix with guard stops inside a parallel round", () => {
		const msgs: BaseMessage[] = [
			q,
			call("a"),
			unbound("a"),
			call("b"),
			stop("b1"),
			unbound("b2"),
			call("c"),
			unbound("c"),
		];
		expect(shouldForceFinalTurn(msgs)).toBe(true);
	});

	test("two blocked rounds is not enough", () => {
		expect(shouldForceFinalTurn([q, call("a"), real("a"), call("b"), stop("b"), call("c"), stop("c")])).toBe(false);
	});

	test("one real result anywhere in the window resets it, even beside a stop in the same round", () => {
		const msgs: BaseMessage[] = [q, call("a"), stop("a"), call("b"), stop("b1"), real("b2"), call("c"), stop("c")];
		expect(shouldForceFinalTurn(msgs)).toBe(false);
	});

	test("first turn and an all-blocked run shorter than the window are left alone", () => {
		expect(shouldForceFinalTurn([q])).toBe(false);
		expect(shouldForceFinalTurn([q, call("a"), stop("a"), call("b"), stop("b")])).toBe(false);
	});

	test("does not key on stop-message wording: an unmarked message with stop-like text is a real result", () => {
		const lookalike = new ToolMessage({
			content: "This tool has returned nothing useful several times in a row.",
			tool_call_id: "x",
		});
		expect(shouldForceFinalTurn([q, call("a"), stop("a"), call("b"), stop("b"), call("x"), lookalike])).toBe(false);
	});

	// Greptile, PR #808: a code search or log query can legitimately return these words.
	test("a successful result that merely CONTAINS the not-found text is evidence, not a refusal", () => {
		const evidence = new ToolMessage({
			status: "success",
			name: "gitlab_search",
			content: '[{"path":"src/agent.ts","data":"throw new Error(`Tool \\"x\\" not found.`)"}]',
			tool_call_id: "x",
		});
		const leading = new ToolMessage({
			status: "success",
			content: 'Error: Tool "x" not found. (quoted from a log line)',
			tool_call_id: "y",
		});
		expect(shouldForceFinalTurn([q, call("a"), stop("a"), call("b"), stop("b"), call("x"), evidence])).toBe(false);
		expect(shouldForceFinalTurn([q, call("a"), stop("a"), call("b"), stop("b"), call("y"), leading])).toBe(false);
	});

	// The marker has to actually be on what the instrumentation emits, or the predicate is inert.
	test("a real loop-guard stop from instrumentTools carries the marker", async () => {
		const t = tool(async () => "[]", { name: "gitlab_search", description: "x", schema: z.object({ q: z.string() }) });
		const [wrapped] = instrumentTools([t], { dataSourceId: "gitlab", log: { info: () => {}, warn: () => {} } });
		const invoke = (id: string) =>
			wrapped?.invoke({ id, name: "gitlab_search", args: { q: "same" }, type: "tool_call" });
		await invoke("1");
		const second = await invoke("2");
		expect(second).toBeInstanceOf(ToolMessage);
		expect((second as ToolMessage).additional_kwargs[LOOP_GUARD_STOP_MARKER]).toBe(true);
	});
});
