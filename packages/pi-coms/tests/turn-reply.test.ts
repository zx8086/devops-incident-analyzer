// tests/turn-reply.test.ts
import { expect, test } from "bun:test";
import { buildTurnReplies, outboundHops } from "../extensions/turnReply";

const text = "Investigation complete: no observed WAF changes in the last 72h.";

test("replies to every unfulfilled inbound with the turn's final text", () => {
	const replies = buildTurnReplies(
		[
			{ msg_id: "m1", fulfilled: false },
			{ msg_id: "m2", fulfilled: false },
			{ msg_id: "m3", fulfilled: false },
		],
		text,
	);
	expect(replies).toEqual([
		{ msg_id: "m1", response: text, error: null },
		{ msg_id: "m2", response: text, error: null },
		{ msg_id: "m3", response: text, error: null },
	]);
});

test("replies oldest-first (input order preserved)", () => {
	const replies = buildTurnReplies(
		[
			{ msg_id: "older", fulfilled: false },
			{ msg_id: "newer", fulfilled: false },
		],
		text,
	);
	expect(replies.map((r) => r.msg_id)).toEqual(["older", "newer"]);
});

test("skips already-fulfilled inbounds", () => {
	const replies = buildTurnReplies(
		[
			{ msg_id: "done", fulfilled: true },
			{ msg_id: "pending", fulfilled: false },
		],
		text,
	);
	expect(replies.map((r) => r.msg_id)).toEqual(["pending"]);
});

test("empty queue yields no replies", () => {
	expect(buildTurnReplies([], text)).toEqual([]);
});

// SIO-1611: outbound hops derive from every unfulfilled inbound of the turn,
// not from whichever prompt arrived last.
test("outboundHops is 0 for a user-started turn", () => {
	expect(outboundHops([])).toBe(0);
});

test("outboundHops is one past the deepest unfulfilled inbound", () => {
	expect(
		outboundHops([
			{ hops: 4, fulfilled: false },
			{ hops: 0, fulfilled: false },
		]),
	).toBe(5);
});

test("outboundHops ignores fulfilled inbounds", () => {
	expect(
		outboundHops([
			{ hops: 4, fulfilled: true },
			{ hops: 1, fulfilled: false },
		]),
	).toBe(2);
	expect(outboundHops([{ hops: 4, fulfilled: true }])).toBe(0);
});

test("schema inbound gets JSON extracted from fenced output", () => {
	const obj = { verdict: "clean" };
	const replies = buildTurnReplies(
		[{ msg_id: "m1", fulfilled: false, response_schema: { type: "object" } }],
		`Here you go:\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``,
	);
	expect(replies).toEqual([{ msg_id: "m1", response: obj, error: null }]);
});

test("schema inbound with non-JSON text reports the extraction error", () => {
	const replies = buildTurnReplies(
		[{ msg_id: "m1", fulfilled: false, response_schema: { type: "object" } }],
		"sorry, plain prose only",
	);
	expect(replies).toEqual([{ msg_id: "m1", response: null, error: "response not valid JSON" }]);
});

test("mixed schema and plain inbounds each get their own treatment", () => {
	const obj = { ok: true };
	const raw = JSON.stringify(obj);
	const replies = buildTurnReplies(
		[
			{ msg_id: "plain", fulfilled: false },
			{ msg_id: "schema", fulfilled: false, response_schema: { type: "object" } },
		],
		raw,
	);
	expect(replies).toEqual([
		{ msg_id: "plain", response: raw, error: null },
		{ msg_id: "schema", response: obj, error: null },
	]);
});

// SIO-1625: the agent_end text extraction and the claim-before-post step
// moved out of the extension so they can be tested here.
import { claimTurnReplies, lastAssistantText } from "../extensions/turnReply";

test("lastAssistantText takes the latest assistant message and joins its text blocks", () => {
	const messages = [
		{ role: "user", content: "question" },
		{ role: "assistant", content: "first answer" },
		{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "final" },
				{ type: "toolCall", name: "bash" },
				{ type: "text", text: "answer" },
			],
		},
	];
	expect(lastAssistantText(messages)).toBe("final\nanswer");
});

test("lastAssistantText accepts string content and returns empty when no assistant spoke", () => {
	expect(lastAssistantText([{ role: "assistant", content: "plain" }])).toBe("plain");
	expect(lastAssistantText([{ role: "user", content: "only me" }])).toBe("");
	expect(lastAssistantText([{ role: "assistant", content: [{ type: "text", text: 42 }] }])).toBe("");
});

test("claimTurnReplies replies once per unfulfilled inbound and empties the queue", () => {
	const queue = new Map([
		["M1", { msg_id: "M1", fulfilled: false, hops: 0 }],
		["M2", { msg_id: "M2", fulfilled: true, hops: 0 }],
		["M3", { msg_id: "M3", fulfilled: false, hops: 1, response_schema: { type: "object" } }],
	]);
	const replies = claimTurnReplies(queue, '{"ok":true}');
	expect(replies.map((r) => r.msg_id)).toEqual(["M1", "M3"]);
	expect(replies[1]?.response).toEqual({ ok: true });
	expect(queue.has("M1")).toBe(false);
	expect(queue.has("M3")).toBe(false);
	// The already-fulfilled entry is left alone for its owner to drop.
	expect(queue.get("M2")?.fulfilled).toBe(true);
	// A second agent_end for the same turn has nothing left to submit.
	expect(claimTurnReplies(queue, "later text")).toEqual([]);
});

// SIO-1678: a run that ended in error, was aborted, or produced no assistant
// text must answer the sender with an ERROR, never a completed empty body.
// (eu-oit-prd 2026-09-09: every Bedrock call 403'd and every prompt was
// answered `complete` + "" within 200 ms.)
import { finalAssistant } from "../extensions/turnReply";

test("finalAssistant carries the last assistant message's stopReason and errorMessage", () => {
	const messages = [
		{ role: "user", content: "question" },
		{ role: "assistant", content: "first answer", stopReason: "stop" },
		{
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "AccessDeniedException: Model access is denied",
		},
	];
	expect(finalAssistant(messages)).toEqual({
		text: "",
		stopReason: "error",
		errorMessage: "AccessDeniedException: Model access is denied",
	});
	expect(finalAssistant([{ role: "assistant", content: "plain" }])).toEqual({
		text: "plain",
		stopReason: undefined,
		errorMessage: undefined,
	});
});

test("an errored run answers every inbound with the error, schema or not", () => {
	const turn = { text: "", stopReason: "error", errorMessage: "AccessDeniedException: Model access is denied" };
	const replies = buildTurnReplies(
		[
			{ msg_id: "plain", fulfilled: false },
			{ msg_id: "schema", fulfilled: false, response_schema: { type: "object" } },
		],
		turn,
	);
	expect(replies).toEqual([
		{ msg_id: "plain", response: null, error: "agent run error: AccessDeniedException: Model access is denied" },
		{ msg_id: "schema", response: null, error: "agent run error: AccessDeniedException: Model access is denied" },
	]);
});

test("an aborted run answers with an error even when earlier text exists", () => {
	const turn = finalAssistant([
		{ role: "assistant", content: "partial", stopReason: "stop" },
		{ role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "aborted" },
	]);
	expect(buildTurnReplies([{ msg_id: "m1", fulfilled: false }], turn)).toEqual([
		{ msg_id: "m1", response: null, error: "agent run aborted: no details" },
	]);
});

test("a completed run with no assistant text is an empty-reply error, not a blank success", () => {
	const turn = finalAssistant([
		{ role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "stop" },
	]);
	expect(buildTurnReplies([{ msg_id: "m1", fulfilled: false }], turn)).toEqual([
		{ msg_id: "m1", response: null, error: "empty reply: no assistant text" },
	]);
	expect(buildTurnReplies([{ msg_id: "m1", fulfilled: false }], "   \n")).toEqual([
		{ msg_id: "m1", response: null, error: "empty reply: no assistant text" },
	]);
});

test("claimTurnReplies accepts the finalAssistant result", () => {
	const queue = new Map([["M1", { msg_id: "M1", fulfilled: false, hops: 0 }]]);
	const replies = claimTurnReplies(queue, { text: "", stopReason: "error", errorMessage: "boom" });
	expect(replies).toEqual([{ msg_id: "M1", response: null, error: "agent run error: boom" }]);
	expect(queue.size).toBe(0);
});

test("claimTurnReplies with `only` leaves inbounds that arrived after the run ended", () => {
	const queue = new Map([
		["ran", { msg_id: "ran", fulfilled: false, hops: 0 }],
		["late", { msg_id: "late", fulfilled: false, hops: 0 }],
	]);
	const replies = claimTurnReplies(queue, "answer", new Set(["ran"]));
	expect(replies).toEqual([{ msg_id: "ran", response: "answer", error: null }]);
	expect(queue.has("ran")).toBe(false);
	expect(queue.get("late")?.fulfilled).toBe(false);
});

// Second-pass review (SIO-1678): the remaining stop reasons and the
// failure + `only` combination that the incident actually exercised.
import { turnFailure } from "../extensions/turnReply";

test("turnFailure names every failed or textless outcome", () => {
	expect(turnFailure({ text: "ok", stopReason: "stop" })).toBeNull();
	expect(turnFailure({ text: "ok" })).toBeNull();
	expect(turnFailure({ text: "partial", stopReason: "length" })).toBe(
		"agent run length: answer truncated at the output token limit",
	);
	expect(turnFailure({ text: "", stopReason: "deferred" })).toBe("agent run deferred: no assistant text");
	expect(turnFailure({ text: "", stopReason: "toolUse" })).toBe("empty reply: no assistant text");
	expect(turnFailure({ text: "", stopReason: "error", errorMessage: "  " })).toBe("agent run error: no details");
});

test("a failed turn with `only` answers the run's inbounds and leaves a late one for the next run", () => {
	const queue = new Map([
		["ran", { msg_id: "ran", fulfilled: false, hops: 0 }],
		["late", { msg_id: "late", fulfilled: false, hops: 0 }],
	]);
	const replies = claimTurnReplies(
		queue,
		{ text: "", stopReason: "error", errorMessage: "AccessDeniedException" },
		new Set(["ran", "already-gone"]),
	);
	expect(replies).toEqual([{ msg_id: "ran", response: null, error: "agent run error: AccessDeniedException" }]);
	expect(queue.has("ran")).toBe(false);
	expect(queue.get("late")?.fulfilled).toBe(false);
});
