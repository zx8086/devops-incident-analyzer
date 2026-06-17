// agent/src/state-pruning.test.ts
import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { DEFAULT_PRUNING_CONFIG, needsPruning, pruneState } from "./state-pruning.ts";

const human = (id: string) => new HumanMessage({ id, content: `h-${id}` });

describe("needsPruning", () => {
	test("false when non-system count is at/under maxMessages", () => {
		const msgs = Array.from({ length: 20 }, (_, i) => human(`m${i}`));
		expect(needsPruning(msgs, { maxMessages: 20, preserveSystemMessages: true })).toBe(false);
	});

	test("true when non-system count exceeds maxMessages", () => {
		const msgs = Array.from({ length: 21 }, (_, i) => human(`m${i}`));
		expect(needsPruning(msgs, { maxMessages: 20, preserveSystemMessages: true })).toBe(true);
	});

	test("system messages do not count toward the threshold", () => {
		const msgs = [
			new SystemMessage({ id: "s", content: "sys" }),
			...Array.from({ length: 20 }, (_, i) => human(`m${i}`)),
		];
		expect(needsPruning(msgs, { maxMessages: 20, preserveSystemMessages: true })).toBe(false);
	});
});

describe("pruneState", () => {
	const cfg = { maxMessages: 3, preserveSystemMessages: true };

	test("removes oldest non-system messages beyond the window, keeps system", () => {
		const msgs = [
			new SystemMessage({ id: "sys", content: "s" }),
			human("a"),
			human("b"),
			human("c"),
			human("d"),
			human("e"),
		];
		const { removeIds } = pruneState(msgs, cfg);
		// keep last 3 non-system (c,d,e) + system; remove a,b
		expect(removeIds.sort()).toEqual(["a", "b"]);
	});

	test("drops an orphaned ToolMessage whose AIMessage tool_call fell outside the window", () => {
		// Window keeps last 3: [tool(t1), human(z), human(y)] -- the AIMessage with the
		// matching tool_call is older (removed), so the kept ToolMessage is orphaned.
		const ai = new AIMessage({ id: "ai", content: "", tool_calls: [{ id: "t1", name: "x", args: {} }] });
		const tool = new ToolMessage({ id: "tm", content: "r", tool_call_id: "t1" });
		const msgs = [human("old1"), ai, tool, human("z"), human("y")];
		const { removeIds } = pruneState(msgs, cfg);
		// keep last 3 = tool,z,y; ai is outside -> tool is orphaned -> also removed
		expect(removeIds.sort()).toEqual(["ai", "old1", "tm"]);
	});

	test("keeps a tool-call pair intact when both are in-window", () => {
		const ai = new AIMessage({ id: "ai", content: "", tool_calls: [{ id: "t1", name: "x", args: {} }] });
		const tool = new ToolMessage({ id: "tm", content: "r", tool_call_id: "t1" });
		const msgs = [human("old"), ai, tool];
		const { removeIds } = pruneState(msgs, { maxMessages: 3, preserveSystemMessages: true });
		expect(removeIds).toEqual([]); // 3 fit; nothing removed
	});

	test("empty / short arrays remove nothing", () => {
		expect(pruneState([], cfg).removeIds).toEqual([]);
		expect(pruneState([human("a")], cfg).removeIds).toEqual([]);
	});

	test("messages without an id are never targeted for removal", () => {
		const noId = new HumanMessage({ content: "no id" }); // no id
		const msgs = [noId, human("a"), human("b"), human("c"), human("d")];
		const { removeIds } = pruneState(msgs, cfg);
		// last 3 (b,c,d) kept; candidates a + noId; noId has no id so only "a" removable
		expect(removeIds).toEqual(["a"]);
	});

	test("DEFAULT_PRUNING_CONFIG keeps 20 non-system messages", () => {
		expect(DEFAULT_PRUNING_CONFIG).toEqual({ maxMessages: 20, preserveSystemMessages: true });
	});

	test("preserveSystemMessages: false removes system messages along with old non-system messages", () => {
		const msgs = [
			new SystemMessage({ id: "sys", content: "s" }),
			human("a"),
			human("b"),
			human("c"),
			human("d"),
			human("e"),
		];
		const { removeIds } = pruneState(msgs, { maxMessages: 3, preserveSystemMessages: false });
		// keep last 3 non-system (c,d,e); sys and a,b are both removed
		expect(removeIds.sort()).toEqual(["a", "b", "sys"]);
	});
});
