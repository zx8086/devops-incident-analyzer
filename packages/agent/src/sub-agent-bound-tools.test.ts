// agent/src/sub-agent-bound-tools.test.ts

import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { buildBoundToolsBlock, composeBoundTools } from "./sub-agent.ts";

// Only `name` is read by the composition, so a minimal stub keeps these tests focused on the
// budgeting arithmetic rather than on LangChain tool construction.
function tools(...names: string[]): StructuredToolInterface[] {
	return names.map((name) => ({ name }) as StructuredToolInterface);
}

function namesOf(list: StructuredToolInterface[]): string[] {
	return list.map((t) => t.name);
}

describe("composeBoundTools (SIO-1234)", () => {
	// The regression: both binding helpers prepend, and the caller sliced to 25, so a large head
	// truncated the action-selected tail -- the tools chosen FOR THIS QUERY -- to nothing.
	test("reserves MIN_ACTION_TOOLS slots when the head alone would fill the budget", () => {
		const head = tools(...Array.from({ length: 62 }, (_, i) => `head_${i}`));
		const selected = tools(...Array.from({ length: 40 }, (_, i) => `sel_${i}`));
		const out = namesOf(composeBoundTools(head, selected));
		expect(out).toHaveLength(25);
		expect(out.filter((n) => n.startsWith("sel_"))).toHaveLength(8);
		expect(out.filter((n) => n.startsWith("head_"))).toHaveLength(17);
		// Head order is preserved and it is still FIRST (the SIO-1029/1084 A5 invariant).
		expect(out[0]).toBe("head_0");
		expect(out[16]).toBe("head_16");
		expect(out[17]).toBe("sel_0");
	});

	// Everything in the repo today is under budget; this must stay byte-identical there or the
	// change would silently re-order every agent's tool belt.
	test("is a plain concatenation when head + selected fit under the cap", () => {
		const head = tools("a", "b", "c");
		const selected = tools("d", "e");
		expect(namesOf(composeBoundTools(head, selected))).toEqual(["a", "b", "c", "d", "e"]);
	});

	// gitlab is the largest real composition: 18 promised + 5 selected = 23.
	test("leaves a realistic gitlab-sized composition unchanged", () => {
		const head = tools(...Array.from({ length: 18 }, (_, i) => `g_${i}`));
		const selected = tools(...Array.from({ length: 5 }, (_, i) => `s_${i}`));
		const out = composeBoundTools(head, selected);
		expect(out).toHaveLength(23);
		expect(namesOf(out)).toEqual([...namesOf(head), ...namesOf(selected)]);
	});

	test("does not pad the action quota when fewer selected tools exist", () => {
		const head = tools(...Array.from({ length: 30 }, (_, i) => `h_${i}`));
		const out = namesOf(composeBoundTools(head, tools("only")));
		expect(out).toHaveLength(25);
		expect(out).toContain("only");
		expect(out.filter((n) => n.startsWith("h_"))).toHaveLength(24);
	});

	test("gives the whole budget to the head when nothing was action-selected", () => {
		const head = tools(...Array.from({ length: 30 }, (_, i) => `h_${i}`));
		expect(composeBoundTools(head, [])).toHaveLength(25);
	});

	test("gives the whole budget to selected when there is no head", () => {
		const selected = tools(...Array.from({ length: 40 }, (_, i) => `s_${i}`));
		expect(composeBoundTools([], selected)).toHaveLength(25);
	});

	// requiredHeadTools now PROMOTES required tools that were also action-selected, so the two
	// lists genuinely overlap. Counting a duplicate against the action quota would buy fewer
	// distinct tools than the quota claims.
	test("dedupes head/selected overlap without spending action quota on it", () => {
		const head = tools("dup_a", "dup_b", "head_only");
		const selected = tools("dup_a", "dup_b", "s1", "s2");
		const out = namesOf(composeBoundTools(head, selected));
		expect(out).toEqual(["dup_a", "dup_b", "head_only", "s1", "s2"]);
		expect(new Set(out).size).toBe(out.length);
	});

	test("never exceeds the cap even when both lists are huge", () => {
		const big = tools(...Array.from({ length: 200 }, (_, i) => `x_${i}`));
		const other = tools(...Array.from({ length: 200 }, (_, i) => `y_${i}`));
		expect(composeBoundTools(big, other)).toHaveLength(25);
	});
});

describe("buildBoundToolsBlock (SIO-1234)", () => {
	// This prompt block is the ONLY in-loop lever: `Tool "X" not found` is thrown by LangGraph's
	// ToolNode and never reaches instrumentTools, so no tool-level guard can observe it.
	test("names every bound tool", () => {
		const block = buildBoundToolsBlock(tools("aws_list_estates", "aws_logs_start_query"));
		expect(block).toContain("aws_list_estates");
		expect(block).toContain("aws_logs_start_query");
	});

	// Without the skip instruction a model that notices a missing tool retries it or invents a
	// substitute -- which is how one unbound name burned iterations to the recursion limit.
	test("instructs the model to SKIP and record a gap rather than retry", () => {
		const block = buildBoundToolsBlock(tools("a_b"));
		expect(block).toMatch(/SKIP/);
		expect(block).toContain("un-queried gap");
		expect(block).toMatch(/do not retry/i);
	});

	// SIO-1234's intent was "never render a dangling empty list -- say something explicit". SIO-1257
	// keeps that intent but states it far more usefully than the bare "(none)" token, so this now
	// asserts the GUARANTEE rather than the literal string it used to be spelled with.
	test("degrades to an explicit statement rather than an empty list", () => {
		const block = buildBoundToolsBlock([]);
		expect(block).toContain("No tools are bound to you this turn");
		expect(block).not.toMatch(/available to you on this turn:\s*$/m);
	});

	// SIO-1257 (CodeRabbit, PR #499): the empty belt is REACHABLE -- getToolsForDataSource returns []
	// for a disconnected MCP server (konnect is disabled by design) and selectToolsByAction passes it
	// straight through. The non-empty block tells the agent to "make at least one call from this
	// list", which is impossible with an empty list and would push it to fabricate one: the mirror
	// image of the deferral bug this block exists to fix.
	test("an empty belt does not demand a tool call", () => {
		const block = buildBoundToolsBlock([]);
		expect(block).toContain("un-queried gap");
		expect(block).not.toContain("Make at least one call from this list");
		expect(block).not.toContain("pick the closest bound tool and run it");
		// ...and it must not license a claim about the datasource either.
		expect(block).toContain("no evidence either way");
	});

	test("a non-empty belt keeps the must-query imperative", () => {
		const block = buildBoundToolsBlock(tools("kafka_list_topics"));
		expect(block).toContain("kafka_list_topics");
		expect(block).toContain("make at least one call from this list");
		expect(block).not.toContain("No tools are bound");
	});
});
