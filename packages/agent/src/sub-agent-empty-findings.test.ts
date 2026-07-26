// agent/src/sub-agent-empty-findings.test.ts

import { describe, expect, test } from "bun:test";
import { lastTextualResponse } from "./sub-agent.ts";

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
