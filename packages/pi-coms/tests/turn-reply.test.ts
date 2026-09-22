// tests/turn-reply.test.ts
import { expect, test } from "bun:test";
import {
	buildTurnReplies,
	nextRunHealth,
	notJsonError,
	outboundHops,
	type RunHealth,
	schemaMismatchError,
} from "../extensions/turnReply";

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
	// SIO-1804: the error keeps its prefix and now says what the spoke's model actually said.
	expect(replies).toEqual([
		{
			msg_id: "m1",
			response: null,
			// SIO-1833: the cause is named ahead of the text, with the offending token
			// redacted -- Bun quotes it straight from the payload (Greptile P1 on #861).
			error:
				'response not valid JSON (23 chars, stop=unknown; parse error: Unexpected identifier "..."; text: sorry, plain prose only)',
		},
	]);
});

// SIO-1804: a live failure could only be called "intermittent" because the text was thrown
// away. The error must be enough to tell prose from a payload and a clean end from a cut
// one, and must stay bounded: it travels on the hub message, onto the sender's card and
// into the monitor's one-line "(uninvestigated: ...)" digest entry.
test("a long unparseable reply is reported by its length, stop reason, head and tail", () => {
	const text = `Here is the verdict:\n{"verdict":"confirmed","summary":"${"x".repeat(5000)}\nEND OF TEXT, never closed`;
	const error = notJsonError({ text, stopReason: "stop" });
	expect(error.startsWith("response not valid JSON (")).toBe(true);
	expect(error).toContain(`${text.trim().length} chars, stop=stop`);
	expect(error).toContain('starts: Here is the verdict: {"verdict":"confirmed"');
	expect(error).toContain("ends: ");
	expect(error.endsWith("END OF TEXT, never closed)")).toBe(true);
	expect(error.includes("\n")).toBe(false);
	expect(error.length).toBeLessThan(450);
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

// SIO-1681: the heartbeat's health signal. A spoke whose every model call 403s
// answered each prompt in 200 ms and still reported "online" for two hours
// (eu-oit-prd 2026-09-09), so discovery depended on someone prompting it.
test("runHealth counts only provider failures, not a clean turn with no text", () => {
	const zero = { consecutive_run_errors: 0 };
	// A model/provider failure is the only thing that counts.
	const one = nextRunHealth(zero, { text: "", stopReason: "error", errorMessage: "AccessDeniedException: 403" });
	expect(one.consecutive_run_errors).toBe(1);
	expect(one.last_run_error).toBe("AccessDeniedException: 403");

	// An aborted run is a local cancellation, not a sick model: it must not
	// accumulate, or every Esc keypress would look like an outage.
	expect(nextRunHealth(one, { text: "", stopReason: "aborted" }).consecutive_run_errors).toBe(1);

	// A clean stop that simply produced no text is a reply-level problem
	// (SIO-1678 answers it with an error), not a model-health problem.
	expect(nextRunHealth(one, { text: "", stopReason: "stop" }).consecutive_run_errors).toBe(0);
});

test("runHealth accumulates across failures and resets on one good turn", () => {
	let h: RunHealth = { consecutive_run_errors: 0 };
	for (let i = 0; i < 9; i++) h = nextRunHealth(h, { text: "", stopReason: "error", errorMessage: "403" });
	expect(h.consecutive_run_errors).toBe(9);

	h = nextRunHealth(h, { text: "ok", stopReason: "stop" });
	expect(h.consecutive_run_errors).toBe(0);
	expect(h.last_run_error).toBeUndefined();
});

// A truncated answer means the model ANSWERED; the spoke is healthy and the
// operator should not be paged for an output-limit stop.
test("runHealth treats a length stop as healthy", () => {
	const h = nextRunHealth({ consecutive_run_errors: 2 }, { text: "partial", stopReason: "length" });
	expect(h.consecutive_run_errors).toBe(0);
});

// SIO-1831: the spoke validates against the schema it was HANDED. Before this, any
// JSON passed as `error: null` and the sender discarded it ~90 s later with only a warn.

// PI_INVESTIGATION_RESPONSE_SCHEMA, copied VERBATIM from packages/shared/src/pi-coms-types.ts.
// Greptile on #859: an abbreviated copy (no evidence item requirements, no item types, no
// confidence bounds) meant every rejection exited through missingRequiredKeys before
// Value.Check ran, so the typebox call was never actually under test.
const investigateSchema = {
	type: "object",
	required: ["summary", "root_cause_hypothesis", "evidence", "suggested_actions", "confidence"],
	properties: {
		summary: { type: "string" },
		root_cause_hypothesis: { type: "string" },
		evidence: {
			type: "array",
			items: {
				type: "object",
				required: ["resource", "observation"],
				properties: { resource: { type: "string" }, observation: { type: "string" } },
			},
		},
		suggested_actions: { type: "array", items: { type: "string" } },
		confidence: { type: "number", minimum: 0, maximum: 1 },
	},
};

// The REAL captured reply from SIO-1830 (redacted, shape-verbatim). An invented
// fixture would encode the same assumption that let this through in the first place.
const diagnosesEnvelope = {
	diagnoses: [
		{
			dedup_key: "logs:/ecs/fargate/redacted-log-group:redacted",
			probable_cause: "an unguarded Optional.get() threw NoSuchElementException",
			affected_resources: ["arn:redacted:service", "arn:redacted:log-group"],
			suggested_action: "add a null/absence check around the Optional.get()",
			evidence: [{ command: "aws logs filter-log-events", observation: "5 distinct events" }],
			confidence: 0.75,
		},
	],
};

test("SIO-1831: a mismatched shape fails HERE, naming the mismatch, instead of passing as a reply", () => {
	const replies = buildTurnReplies(
		[{ msg_id: "m1", fulfilled: false, response_schema: investigateSchema }],
		JSON.stringify(diagnosesEnvelope),
	);

	expect(replies).toHaveLength(1);
	const [reply] = replies;
	expect(reply?.response).toBeNull();
	expect(reply?.error).toContain("did not match the requested schema");
	// Names what arrived and what was wanted, so the sender need not pull the body.
	expect(reply?.error).toContain("got keys: diagnoses");
	expect(reply?.error).toContain("missing required: summary");
	// KEY NAMES only: no value from the payload may leak into the error.
	expect(reply?.error).not.toContain("Optional.get");
	expect(reply?.error).not.toContain("arn:redacted");
	expect(reply?.error).not.toContain("redacted-log-group");
});

test("SIO-1831: a reply that MATCHES the schema is unaffected", () => {
	const good = {
		summary: "s",
		root_cause_hypothesis: "r",
		evidence: [{ resource: "x", observation: "y" }],
		suggested_actions: ["do a thing"],
		confidence: 0.6,
	};
	const replies = buildTurnReplies(
		[{ msg_id: "m1", fulfilled: false, response_schema: investigateSchema }],
		JSON.stringify(good),
	);
	expect(replies).toEqual([{ msg_id: "m1", response: good, error: null }]);
});

test("SIO-1831: a request with NO response_schema still returns prose verbatim", () => {
	const replies = buildTurnReplies([{ msg_id: "m1", fulfilled: false }], "just prose, no schema asked for");
	expect(replies).toEqual([{ msg_id: "m1", response: "just prose, no schema asked for", error: null }]);
});

// A spoke must never be made to fail every reply by a schema this validator cannot
// read. Unknown/exotic schemas fall back to the pre-SIO-1831 behaviour: accept and
// let the sender decide.
test("SIO-1831: an unparseable schema accepts the payload rather than failing shut", () => {
	const replies = buildTurnReplies(
		[{ msg_id: "m1", fulfilled: false, response_schema: { type: "not-a-real-type", $ref: "#/nope" } }],
		JSON.stringify({ anything: 1 }),
	);
	expect(replies[0]?.error).toBeNull();
	expect(replies[0]?.response).toEqual({ anything: 1 });
});

test("SIO-1831: schemaMismatchError caps the key list and never prints values", () => {
	const many: Record<string, number> = {};
	for (let i = 0; i < 40; i++) many[`k${i}`] = i;
	const msg = schemaMismatchError({ type: "object", required: ["a"] }, many);
	expect(msg).toContain("k0");
	expect(msg).not.toContain("k39");
	expect(msg).toContain("missing required: a");

	// A non-object payload is described by its type, not dumped.
	expect(schemaMismatchError({ type: "object", required: ["a"] }, ["secret-value"])).toContain("got an array");
	expect(schemaMismatchError({ type: "object", required: ["a"] }, ["secret-value"])).not.toContain("secret-value");
});

// Greptile on #859: these are the cases that actually exercise Value.Check. Every
// required top-level key is present, so missingRequiredKeys returns empty and the
// typebox call is the only thing that can reject them. Replacing Value.Check with
// `true` turns each of these red.
const wellFormedExcept = (patch: Record<string, unknown>) => ({
	summary: "s",
	root_cause_hypothesis: "r",
	evidence: [{ resource: "arn:x", observation: "o" }],
	suggested_actions: ["do a thing"],
	confidence: 0.5,
	...patch,
});

test.each([
	["a string confidence", { confidence: "high" }],
	["confidence above the maximum", { confidence: 1.5 }],
	["confidence below the minimum", { confidence: -0.1 }],
	["an evidence item missing observation", { evidence: [{ resource: "arn:x" }] }],
	["a non-string suggested action", { suggested_actions: [42] }],
	["evidence that is not an array", { evidence: "none" }],
])("SIO-1831: rejects %s, with every required key present", (_label, patch) => {
	const payload = wellFormedExcept(patch);
	// Precondition: this case must NOT be caught by the required-key check, or it
	// would not test Value.Check at all.
	expect(Object.keys(payload)).toEqual(
		expect.arrayContaining(["summary", "root_cause_hypothesis", "evidence", "suggested_actions", "confidence"]),
	);

	const replies = buildTurnReplies(
		[{ msg_id: "m1", fulfilled: false, response_schema: investigateSchema }],
		JSON.stringify(payload),
	);

	expect(replies[0]?.response).toBeNull();
	expect(replies[0]?.error).toContain("did not match the requested schema");
	// Names WHERE it failed, not just which keys arrived.
	expect(replies[0]?.error).toContain("failed at:");
	expect(replies[0]?.error).not.toContain("missing required");
});

test("SIO-1831: a nested failure names the path and never prints the offending value", () => {
	const replies = buildTurnReplies(
		[{ msg_id: "m1", fulfilled: false, response_schema: investigateSchema }],
		JSON.stringify(wellFormedExcept({ evidence: [{ resource: "arn:super-secret-account-id", observation: 7 }] })),
	);

	const error = replies[0]?.error ?? "";
	expect(error).toContain("failed at:");
	expect(error).toContain("/evidence/0/observation");
	// The payload value must never reach the error string.
	expect(error).not.toContain("arn:super-secret-account-id");
	expect(error).not.toContain("7");
});

// SIO-1833: the error an operator reads must name the CAUSE, not just the length.
test("SIO-1833: notJsonError reports why the payload failed to parse", () => {
	const body = `{"diagnoses":[{"probable_cause":"${"p".repeat(400)}"},]}`;
	const msg = notJsonError({ text: `\`\`\`json\n${body}\n\`\`\``, stopReason: "stop" });

	expect(msg).toContain("parse error:");
	expect(msg).toContain("comma");
	// The pre-existing facts are kept, not replaced.
	expect(msg).toContain("stop=stop");
	expect(msg).toContain("starts:");
	expect(msg).toContain("ends:");
});

test("SIO-1833: a short non-JSON reply keeps printing its whole text, with a cause", () => {
	const msg = notJsonError({ text: "sorry, plain prose only", stopReason: "stop" });
	expect(msg).toContain("text: sorry, plain prose only");
	expect(msg).toContain("parse error:");
});

// Greptile P1 on #861: the 450 budget is on the COMPOSED error. Two failing fences
// plus two 160-char excerpts reached 492 before the cap was measured rather than guessed.
test("SIO-1833: a long reply with MULTIPLE bad fences still fits the SIO-1804 budget", () => {
	// biome-ignore lint/style/useTemplate: SIO-1865 - the fixture contains ``` fences; a template literal would nest backticks
	const text = '```json\n{"a":1,}\n```\n```json\n{"b":2,}\n```\n' + "z".repeat(400);
	const error = notJsonError({ text, stopReason: "stop" });
	expect(error).toContain("parse error:");
	expect(error.length).toBeLessThan(450);
});
