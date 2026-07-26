// agent/src/sub-agent-empty-findings.test.ts

import { describe, expect, test } from "bun:test";
import { buildSubAgentOutcome, lastTextualResponse } from "./sub-agent.ts";

// SIO-1227: queryDataSource used to read `messages.at(-1)` alone, so a datasource's entire
// findings were lost whenever the final message carried no text -- while still reporting
// status "success". Both shapes below were observed in the SIO-1224 acceptance eval
// (experiment agent-eval-094b203a): one elastic run and two truncated gitlab runs returned
// responseLength 0 after 94-159 seconds of real tool work.
//
// These test the pure walk-back helper. The status/error wiring around it is asserted in
// sub-agent.test.ts, which owns the queryDataSource fixtures.

const ai = (content: unknown) => ({ content, _getType: () => "ai" });
const tool = (content: unknown) => ({ content, _getType: () => "tool" });
const human = (content: unknown) => ({ content, _getType: () => "human" });

describe("lastTextualResponse", () => {
	test("returns the final message's text on the normal path", () => {
		const messages = [human("investigate"), ai("Findings: lag is 4.2M on orders-v2.")];
		expect(lastTextualResponse(messages)).toEqual({ text: "Findings: lag is 4.2M on orders-v2.", index: 1 });
	});

	// Shape 1: Sonnet 5 ends the loop with a reasoning-only block and no text block. This is the
	// elastic case from the eval -- 6 messages, no truncation, no tool errors, responseLength 0.
	test("walks back past a reasoning-only final message", () => {
		const messages = [
			human("investigate"),
			ai("Findings: 503 rate rose to 41% at 12:04Z."),
			ai([{ type: "reasoning", reasoning: "internal deliberation", signature: "abc123" }]),
		];
		expect(lastTextualResponse(messages)).toEqual({ text: "Findings: 503 rate rose to 41% at 12:04Z.", index: 1 });
	});

	// Shape 2: a recursion-limit salvage, where the last message is mid-loop. The findings the
	// loop DID gather sit in an earlier assistant turn, and the old code threw them away.
	test("walks back past a trailing tool message on a truncated run", () => {
		const messages = [
			human("investigate"),
			ai("Partial findings: pipeline 44821 deployed at 11:58Z."),
			ai([{ type: "tool_use", id: "t1", name: "gitlab_search", input: {} }]),
			tool('{"error":"timed out"}'),
		];
		expect(lastTextualResponse(messages)).toEqual({
			text: "Partial findings: pipeline 44821 deployed at 11:58Z.",
			index: 1,
		});
	});

	test("returns null when no assistant message yields text", () => {
		const messages = [
			human("investigate"),
			ai([{ type: "reasoning", reasoning: "thinking", signature: "sig" }]),
			tool('{"rows":[]}'),
		];
		expect(lastTextualResponse(messages)).toBeNull();
	});

	// A ToolMessage's content is raw tool output, not an answer. Splicing it into r.data would
	// feed the aggregator unlabelled JSON that reads as the sub-agent's own findings.
	test("never recovers text from a tool message", () => {
		const messages = [human("investigate"), tool("Total results: 91 for error X")];
		expect(lastTextualResponse(messages)).toBeNull();
	});

	test("ignores the human turn, so an empty run cannot echo the query back as findings", () => {
		expect(lastTextualResponse([human("investigate prana-order-service")])).toBeNull();
	});

	test("treats a whitespace-only assistant message as no text", () => {
		expect(lastTextualResponse([ai("   \n\t  ")])).toBeNull();
	});

	test("prefers the LATEST assistant message that has text", () => {
		const messages = [ai("first pass"), tool("{}"), ai("second pass, more complete"), tool("{}")];
		expect(lastTextualResponse(messages)).toEqual({ text: "second pass, more complete", index: 2 });
	});

	test("handles an empty message list", () => {
		expect(lastTextualResponse([])).toBeNull();
	});

	// Mixed block arrays are the common Sonnet 5 shape: reasoning first, then the answer.
	test("extracts text from a mixed reasoning+text block array", () => {
		const messages = [
			ai([
				{ type: "reasoning", reasoning: "deliberating", signature: "s" },
				{ type: "text", text: "Root cause: consumer fleet stalled." },
			]),
		];
		expect(lastTextualResponse(messages)).toEqual({ text: "Root cause: consumer fleet stalled.", index: 0 });
	});
});

// SIO-1227 review: the helper tests above can all pass while the completion contract regresses,
// so assert that contract directly. buildSubAgentOutcome was extracted from queryDataSource for
// exactly this reason -- driving queryDataSource itself would need createReactAgent, the MCP tool
// layer and prompt-context mocked, and mocking prompt-context is a known source of cross-file
// mock pollution in this package.
describe("buildSubAgentOutcome (the completion contract)", () => {
	const found = { text: "Findings: lag is 4.2M.", index: 3 };

	test("normal run returns success with the recovered text and no error", () => {
		expect(
			buildSubAgentOutcome({
				recovered: found,
				allToolsFailed: false,
				truncated: false,
				messageCount: 4,
				toolErrorCount: 0,
			}),
		).toEqual({ data: "Findings: lag is 4.2M.", status: "success" });
	});

	// THE invariant: a datasource that produced nothing must not be reported as success, or
	// alignment counts it a win and neither retries nor degrades confidence.
	test("no findings is an error carrying a reason, never empty success", () => {
		const out = buildSubAgentOutcome({
			recovered: null,
			allToolsFailed: false,
			truncated: false,
			messageCount: 6,
			toolErrorCount: 0,
		});
		expect(out.status).toBe("error");
		expect(out.error).toBe("Sub-agent produced no textual findings across 6 messages");
		expect(out.data).toBe("No response from sub-agent");
	});

	test("all-tools-failed keeps its own error reason and takes precedence", () => {
		const out = buildSubAgentOutcome({
			recovered: null,
			allToolsFailed: true,
			truncated: false,
			messageCount: 9,
			toolErrorCount: 4,
		});
		expect(out.status).toBe("error");
		expect(out.error).toBe("All 4 tool calls failed");
	});

	// SIO-1029's intent: a truncated run must still surface what it gathered, not a bare note.
	test("truncated run with recovered findings stays success and appends the salvage note", () => {
		const out = buildSubAgentOutcome({
			recovered: found,
			allToolsFailed: false,
			truncated: true,
			messageCount: 44,
			toolErrorCount: 1,
		});
		expect(out.status).toBe("success");
		expect(out.data).toStartWith("Findings: lag is 4.2M.");
		expect(out.data).toContain("truncated at the sub-agent recursion limit");
		expect(out.error).toBeUndefined();
	});

	test("truncated run with nothing recovered is an error, not a note-only success", () => {
		const out = buildSubAgentOutcome({
			recovered: null,
			allToolsFailed: false,
			truncated: true,
			messageCount: 40,
			toolErrorCount: 2,
		});
		expect(out.status).toBe("error");
		expect(out.data).toContain("truncated at the sub-agent recursion limit");
	});

	// The whole point, stated as a property: success and empty findings are mutually exclusive.
	test("no combination of inputs yields success with no findings", () => {
		for (const allToolsFailed of [false, true]) {
			for (const truncated of [false, true]) {
				const out = buildSubAgentOutcome({
					recovered: null,
					allToolsFailed,
					truncated,
					messageCount: 3,
					toolErrorCount: 1,
				});
				expect(out.status, `allToolsFailed=${allToolsFailed} truncated=${truncated}`).toBe("error");
				expect(out.error).toBeDefined();
			}
		}
	});

	// Pairs with the trim change: the returned text is verbatim, so the contract must not alter it.
	test("preserves the recovered text verbatim, including surrounding whitespace", () => {
		const padded = { text: "\n  Findings with padding  \n", index: 2 };
		const out = buildSubAgentOutcome({
			recovered: padded,
			allToolsFailed: false,
			truncated: false,
			messageCount: 3,
			toolErrorCount: 0,
		});
		expect(out.data).toBe("\n  Findings with padding  \n");
	});
});
