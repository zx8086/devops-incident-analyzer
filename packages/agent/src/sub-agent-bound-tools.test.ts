// agent/src/sub-agent-bound-tools.test.ts

import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { buildBoundToolsBlock, composeBoundTools, describeTruncation } from "./sub-agent.ts";

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

// SIO-1767: the cap truncated positionally and SILENTLY -- nothing recorded that a tool was
// dropped, let alone which one, so nobody could say how often 25 actually bites (SIO-1240
// criteria 3/4). describeTruncation is the log payload, extracted as a pure function because
// this repo does not assert on pino output in unit tests (extract-findings.test.ts:356-365);
// testing it directly covers the arithmetic that decides whether to log and what it names.
describe("describeTruncation (SIO-1767)", () => {
	test("returns undefined when nothing was cut -- a composition that fits stays silent", () => {
		const head = tools("a", "b", "c");
		const tail = tools("d", "e");
		expect(describeTruncation(head, tail, head.length, tail.length, 25, 8)).toBeUndefined();
	});

	test("names the dropped tools, head-first, when the head is cut", () => {
		// The real aws-agent shape: head far over budget, tail reserved to minAction.
		const head = tools(...Array.from({ length: 20 }, (_, i) => `head_${i}`));
		const tail = tools(...Array.from({ length: 10 }, (_, i) => `sel_${i}`));
		const out = describeTruncation(head, tail, 17, 8, 25, 8);
		expect(out).toBeDefined();
		expect(out?.droppedHead).toBe(3);
		expect(out?.droppedTail).toBe(2);
		expect(out?.requested).toBe(30);
		expect(out?.bound).toBe(25);
		// Head drops first, in order, then tail -- mirrors the slice order.
		expect(out?.droppedNames).toEqual(["head_17", "head_18", "head_19", "sel_8", "sel_9"]);
	});

	test("reports a tail-only cut without claiming the head lost anything", () => {
		const head = tools("a", "b");
		const tail = tools(...Array.from({ length: 30 }, (_, i) => `sel_${i}`));
		const out = describeTruncation(head, tail, 2, 23, 25, 8);
		expect(out?.droppedHead).toBe(0);
		expect(out?.droppedTail).toBe(7);
		expect(out?.droppedNames).toEqual(["sel_23", "sel_24", "sel_25", "sel_26", "sel_27", "sel_28", "sel_29"]);
	});

	test("an empty selection with a fitting head is silent", () => {
		const head = tools("a", "b");
		expect(describeTruncation(head, [], 2, 0, 25, 8)).toBeUndefined();
	});

	test("caps a huge dropped list but keeps the COUNTS exact and flags the cap", () => {
		// aws-agent's real head is 62 (skill-tool-coverage.test.ts:38), which would otherwise put
		// ~77 names in one log line.
		const head = tools(...Array.from({ length: 62 }, (_, i) => `head_${i}`));
		const tail = tools(...Array.from({ length: 40 }, (_, i) => `sel_${i}`));
		const out = describeTruncation(head, tail, 17, 8, 25, 8);
		expect(out?.droppedNames).toHaveLength(30);
		expect(out?.droppedNamesTruncated).toBe(true);
		// The counts must NOT be capped -- they are what says how much was really cut.
		expect(out?.droppedHead).toBe(45);
		expect(out?.droppedTail).toBe(32);
		expect(out?.requested).toBe(102);
		expect(out?.bound).toBe(25);
	});

	test("a dropped list at or under the cap is not flagged as truncated", () => {
		const head = tools(...Array.from({ length: 30 }, (_, i) => `h${i}`));
		const out = describeTruncation(head, [], 25, 0, 25, 8);
		expect(out?.droppedNames).toHaveLength(5);
		expect(out?.droppedNamesTruncated).toBeUndefined();
	});

	test("carries max and minAction so a trace is interpretable without reading the source", () => {
		const head = tools(...Array.from({ length: 30 }, (_, i) => `h${i}`));
		const out = describeTruncation(head, [], 25, 0, 25, 8);
		expect(out?.max).toBe(25);
		expect(out?.minAction).toBe(8);
	});
});

// The end-to-end contract: the real composeBoundTools path must produce a cut in exactly the
// cases describeTruncation reports one, so the log cannot drift from the behaviour it describes.
describe("composeBoundTools truncation is observable (SIO-1767)", () => {
	test("the oversubscribed aws-agent shape drops tools, and the return reflects it", () => {
		const head = tools(...Array.from({ length: 62 }, (_, i) => `head_${i}`));
		const selected = tools(...Array.from({ length: 40 }, (_, i) => `sel_${i}`));
		const out = composeBoundTools(head, selected);
		expect(out).toHaveLength(25);
		// 62 + 40 requested, 25 bound -> 77 dropped. The log exists to make that visible.
		expect(head.length + selected.length - out.length).toBe(77);
	});

	test("an under-budget composition binds everything, so there is nothing to report", () => {
		const head = tools("a", "b", "c");
		const selected = tools("d", "e");
		expect(namesOf(composeBoundTools(head, selected))).toEqual(["a", "b", "c", "d", "e"]);
	});
});
