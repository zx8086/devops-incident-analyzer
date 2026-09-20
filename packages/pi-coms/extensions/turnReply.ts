// extensions/turnReply.ts
import { Value } from "typebox/value";
import { extractJsonPayload, jsonParseFailure } from "./jsonPayload.ts";

export interface TurnReplyInbound {
	msg_id: string;
	response_schema?: object | null;
	fulfilled: boolean;
}

// Hop count for a new outbound send: one past the deepest unfulfilled inbound
// the current turn is answering, 0 when the turn was started by the user. A
// single "current inbound" slot got this wrong once prompts stacked (SIO-1611).
export function outboundHops(queue: Iterable<{ hops: number; fulfilled: boolean }>): number {
	let max = -1;
	for (const q of queue) if (!q.fulfilled && q.hops > max) max = q.hops;
	return max + 1;
}

export interface TurnReply {
	msg_id: string;
	response: unknown;
	error: string | null;
}

// The final assistant message of a run, reduced to what a reply needs: its
// text, and how the run ended. A plain string is accepted for callers that
// only have the text.
export interface FinalAssistant {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

// SIO-1678: a run that ended in an error or was aborted, or one whose final
// message carries no text, must be answered with an ERROR. Before this, the
// empty text was posted as a completed reply and every consumer read an empty
// `complete` as an answer (eu-oit-prd 2026-09-09: nine Bedrock 403s, nine
// empty replies, all marked complete within 200 ms).
export function turnFailure(turn: FinalAssistant): string | null {
	if (turn.stopReason === "error" || turn.stopReason === "aborted") {
		return `agent run ${turn.stopReason}: ${turn.errorMessage?.trim() || "no details"}`;
	}
	// A "length" stop is the model cut off at its output limit: whatever text
	// exists is truncated and cannot be trusted as the answer (Pi itself refuses
	// to run tool calls from such a message).
	if (turn.stopReason === "length") return "agent run length: answer truncated at the output token limit";
	if (turn.text.trim() === "") {
		// Any other non-terminal stop reason (pending, deferred) with no text is
		// named, so the sender does not read a still-arriving answer as absent.
		const reason =
			turn.stopReason && turn.stopReason !== "stop" && turn.stopReason !== "toolUse" ? turn.stopReason : null;
		return reason ? `agent run ${reason}: no assistant text` : "empty reply: no assistant text";
	}
	return null;
}

// SIO-1681: the spoke's own view of its model health, carried on the heartbeat.
// `turnFailure` above makes a failed REPLY loud, but that only reaches an
// operator who sent a prompt and read the answer; a spoke nobody prompts stays
// green (eu-oit-prd 2026-09-09: every Bedrock call 403'd for two hours while the
// hub, `fleet status` and the monitor all showed it healthy).
export interface RunHealth {
	consecutive_run_errors: number;
	last_run_error?: string;
	// SIO-1817: how many times in a row the SAME error text has come back. A
	// varying error is a flaky provider; an identical one repeating is a stuck
	// input, and only the second is repairable from here.
	repeated_error_count?: number;
}

// SIO-1817: a malformed toolUse/toolResult pair in the persisted session. The
// provider rejects the whole request before any model work, so every turn fails
// identically at the same message offset until the history is rewritten
// (eu-oit-prd 2026-09-18: 9 failures at `messages.22`, zero successes in 22 h,
// cleared only by deleting the session directory by hand).
//
// Matched on the pairing vocabulary rather than the offset, which varies, and
// deliberately NARROW: this predicate decides whether the spoke rewrites its own
// history, so an access or throttle failure must never match it.
export function isMalformedHistory(message: string | undefined): boolean {
	const m = (message ?? "").toLowerCase();
	if (!m.includes("toolresult") && !m.includes("tooluse")) return false;
	return m.includes("validation") || m.includes("exceeds") || m.includes("corresponding");
}

// Only a PROVIDER failure counts. The other failure modes `turnFailure` reports
// are not model health and must not page anyone:
//   - "aborted" is a local cancellation (an operator pressing Esc),
//   - "length" means the model answered and the answer was truncated,
//   - an empty-but-clean stop is a reply-level problem SIO-1678 already answers.
// Counting those would make the signal fire on healthy spokes, and a health
// signal that cries wolf is worse than none.
export function nextRunHealth(prev: RunHealth, turn: FinalAssistant): RunHealth {
	if (turn.stopReason === "error") {
		const message = turn.errorMessage?.trim() || "no details";
		// SIO-1817: the repeat counter is what separates a stuck input from a
		// flaky provider. Compared on the whole message: the offset it names is
		// part of the identity, so a DIFFERENT malformed pair restarts the count
		// rather than inheriting a repair that was already tried.
		return {
			consecutive_run_errors: prev.consecutive_run_errors + 1,
			last_run_error: message,
			repeated_error_count: prev.last_run_error === message ? (prev.repeated_error_count ?? 1) + 1 : 1,
		};
	}
	if (turn.stopReason === "aborted") return prev;
	return { consecutive_run_errors: 0 };
}

// SIO-1817: how many identical failures before the spoke rewrites its own
// history. Three for the same reason SIO-1681 chose three: one or two can be a
// transient the next turn rides through, and a repair is not free -- compaction
// costs a model call and loses conversational detail.
export const REPAIR_AFTER_REPEATS = 3;

// Both halves must hold: the error is one a history rewrite can actually fix,
// AND it has repeated identically. A repeated ACCESS failure is the case this
// must refuse -- compaction cannot grant a permission, and a spoke silently
// compacting in a loop would bury the 403 that SIO-1681 exists to surface.
export function shouldRepairHistory(health: RunHealth): boolean {
	if (!isMalformedHistory(health.last_run_error)) return false;
	return (health.repeated_error_count ?? 0) >= REPAIR_AFTER_REPEATS;
}

// SIO-1804: a schema-bound reply that would not parse used to be answered with the fixed
// string "response not valid JSON" and the model's text was thrown away, so a live failure
// (eu-shared-services-prd, 2026-09-18) could only be called "intermittent": there was no
// record anywhere of what the spoke had said. The error now says how long the text was, how
// the run stopped, and shows a bounded head and tail, which is enough to tell prose from a
// payload, a fence from none, and a clean end from a cut one. It is bounded because it
// travels on the hub message and onto the sender's card, and it is spoke-authored text:
// rendered as data by the sender, never fed to a model (the PR #682 invariant).
const NOT_JSON_EDGE_CHARS = 160;
// SIO-1833: the parse cause, capped so the WHOLE error stays inside the 450 the
// SIO-1804 test pins. Greptile P1 on #861: 90 was wrong, and wrong by more than double.
// The scaffold plus two 160-char excerpts already costs 403, leaving 47. Measured, not
// estimated. Bun's own messages fit ("Unexpected comma at the end of array expression"
// is 44 after the prefix is stripped), so this trims only a pathological one.
const PARSE_CAUSE_CHARS = 44;

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

// SIO-1833: a prd spoke lost a good Schema Registry diagnosis to
// "response not valid JSON (6288 chars, stop=stop; starts: ... ends: ...)". The
// operator learned the length and the two ends, never the CAUSE, and the log keeps
// 320 of 6288 chars while the hub message ages out within the hour (SIO-1830) -- so
// the failure could not be reproduced afterwards. The parser already knows why;
// it was being discarded. Cause first, because it is the part that is actionable.
export function notJsonError(turn: FinalAssistant): string {
	const text = turn.text.trim();
	// Bounded like the excerpts around it: this error rides the hub message, the
	// sender's card and the monitor's one-line digest entry (SIO-1804), so the cause
	// earns a fixed slice rather than however much the parser felt like saying.
	const cause = jsonParseFailure(text)?.slice(0, PARSE_CAUSE_CHARS);
	const facts = `${text.length} chars, stop=${turn.stopReason ?? "unknown"}${cause ? `; parse error: ${cause}` : ""}`;
	if (text.length <= NOT_JSON_EDGE_CHARS * 2) return `response not valid JSON (${facts}; text: ${oneLine(text)})`;
	const head = oneLine(text.slice(0, NOT_JSON_EDGE_CHARS));
	const tail = oneLine(text.slice(-NOT_JSON_EDGE_CHARS));
	return `response not valid JSON (${facts}; starts: ${head} ... ends: ${tail})`;
}

// SIO-1831: the reply parsed as JSON, but does it match the schema it was HANDED?
// Until now nothing checked. `buildTurnReplies` already had `response_schema` in hand
// and only verified the text WAS JSON, so any shape passed as `error: null` and failed
// ~90 s later at the sender, which can do nothing but log a warn (SIO-1830). Validating
// here turns a silent discard into an actionable error the sender can read.
//
// typebox is already a dependency of this package and is already imported by
// coms-net.ts, so this adds no install weight to `pi install` (SIO-1632).
const MISMATCH_MAX_KEYS = 12;

// The missing REQUIRED top-level keys, which is the diagnosis that actually helps:
// a diagnoses envelope against the investigate schema is missing all five of them.
// typebox reports a bare "(root)" path for that case, so derive the names instead.
function missingRequiredKeys(schema: object, payload: unknown): string[] {
	const required = (schema as { required?: unknown }).required;
	if (!Array.isArray(required)) return [];
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
	const present = new Set(Object.keys(payload));
	return required.filter((k): k is string => typeof k === "string" && !present.has(k));
}

// The failing schema PATHS, for the case every required top-level key is present and
// the break is a wrong type or a missing nested field. Greptile on #859: without this
// the error named only the key list, so a reply rejected on `confidence: "high"` or an
// evidence item missing `observation` told the sender nothing while its body was
// discarded. Paths and expected types only -- never the offending value, which is
// payload data (account ids, arns, trace ids).
function failingSchemaPaths(schema: object, payload: unknown): string[] {
	try {
		const seen = new Set<string>();
		// Field names verified against typebox at runtime, not assumed: an issue carries
		// `instancePath` (where in the payload) and `message` (what was expected).
		for (const issue of Value.Errors(schema as never, payload) as Iterable<{
			instancePath?: unknown;
			message?: unknown;
		}>) {
			const rawPath = typeof issue.instancePath === "string" ? issue.instancePath : "";
			const path = rawPath === "" ? "(root)" : rawPath;
			// `message` is schema-derived ("must be string", "must be <= 1"), never payload text.
			const why = typeof issue.message === "string" ? issue.message : "";
			seen.add(why ? `${path} (${why})` : path);
			if (seen.size >= MISMATCH_MAX_KEYS) break;
		}
		return [...seen];
	} catch {
		return [];
	}
}

// KEY NAMES only, never values: the payload carries account ids, arns and trace ids,
// the same rule the analyzer's replyKeys follows (SIO-1830).
export function schemaMismatchError(schema: object, payload: unknown): string {
	const missing = missingRequiredKeys(schema, payload);
	const got =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? Object.keys(payload).slice(0, MISMATCH_MAX_KEYS)
			: [];
	const gotPart =
		got.length > 0 ? `got keys: ${got.join(", ")}` : `got ${Array.isArray(payload) ? "an array" : typeof payload}`;
	if (missing.length > 0) {
		return `response did not match the requested schema (${gotPart}; missing required: ${missing.slice(0, MISMATCH_MAX_KEYS).join(", ")})`;
	}
	// Every required key is present, so the break is deeper: name the paths.
	const paths = failingSchemaPaths(schema, payload);
	const wherePart = paths.length > 0 ? `; failed at: ${paths.join(", ")}` : "";
	return `response did not match the requested schema (${gotPart}${wherePart})`;
}

// Guard: a schema this validator cannot interpret must NEVER make a spoke fail every
// reply. Measured, not assumed -- typebox does not throw on an exotic schema, it returns
// `false`, so a try/catch guard is useless here: `{$ref}` and `{type:"not-a-real-type"}`
// both come back false and would have rejected every well-formed answer.
//
// So enforce only what is unambiguously enforceable: an object schema that names its
// required keys. Anything else (a bare $ref, an unknown type, the `{type:"object"}`
// placeholder with no `required`) passes through with the pre-SIO-1831 behaviour, and
// the analyzer-side adapter stays the net for it.
function isEnforceable(schema: object): boolean {
	const s = schema as { type?: unknown; required?: unknown };
	return s.type === "object" && Array.isArray(s.required) && s.required.length > 0;
}

function matchesSchema(schema: object, payload: unknown): boolean {
	if (!isEnforceable(schema)) return true;
	// Required keys are checked directly; typebox then covers types and nested shape.
	if (missingRequiredKeys(schema, payload).length > 0) return false;
	try {
		return Value.Check(schema as never, payload);
	} catch {
		return true;
	}
}

// One turn can cover several stacked inbound prompts (followUps merge into the
// running turn), so every unfulfilled inbound gets the turn's final assistant
// text as its reply -- oldest first, each under its own response_schema rule.
export function buildTurnReplies(inbounds: TurnReplyInbound[], turn: string | FinalAssistant): TurnReply[] {
	const final: FinalAssistant = typeof turn === "string" ? { text: turn } : turn;
	const failure = turnFailure(final);
	const lastAssistantText = final.text;
	const replies: TurnReply[] = [];
	for (const inbound of inbounds) {
		if (inbound.fulfilled) continue;
		if (failure !== null) {
			replies.push({ msg_id: inbound.msg_id, response: null, error: failure });
		} else if (inbound.response_schema && typeof inbound.response_schema === "object") {
			const schema = inbound.response_schema;
			const parsed = extractJsonPayload(lastAssistantText);
			if (parsed === undefined) {
				replies.push({ msg_id: inbound.msg_id, response: null, error: notJsonError(final) });
			} else if (!matchesSchema(schema, parsed)) {
				// SIO-1831: fail HERE, naming the mismatch, rather than sending a shape the
				// caller cannot read and letting it discard the answer silently.
				replies.push({ msg_id: inbound.msg_id, response: null, error: schemaMismatchError(schema, parsed) });
			} else {
				replies.push({ msg_id: inbound.msg_id, response: parsed, error: null });
			}
		} else {
			replies.push({ msg_id: inbound.msg_id, response: lastAssistantText, error: null });
		}
	}
	return replies;
}

// Pi's AgentMessage union includes entries without content (bash execution).
// Assistant entries also carry how the model call ended (`stopReason`
// "stop" | "length" | "toolUse" | "error" | "aborted") and, on error, the
// provider's message.
export interface TurnMessage {
	role: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

// The final assistant message of a run: the latest assistant message wins, text
// blocks join with "\n", thinking and tool-call blocks are not part of a reply.
export function finalAssistant(messages: Iterable<TurnMessage>): FinalAssistant {
	let text = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		stopReason = typeof m.stopReason === "string" ? m.stopReason : undefined;
		errorMessage = typeof m.errorMessage === "string" ? m.errorMessage : undefined;
		const content = m.content;
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter(
					(b): b is { type: "text"; text: string } =>
						!!b &&
						typeof b === "object" &&
						(b as { type?: unknown }).type === "text" &&
						typeof (b as { text?: unknown }).text === "string",
				)
				.map((b) => b.text)
				.join("\n");
		} else {
			text = "";
		}
	}
	return { text, stopReason, errorMessage };
}

export function lastAssistantText(messages: Iterable<TurnMessage>): string {
	return finalAssistant(messages).text;
}

// Build the replies and take their entries out of the queue in one step, so
// a second agent_end for the same turn cannot submit them again (SIO-1611).
// `only` restricts the claim to the inbounds that were queued when the run
// ended (SIO-1678: replies are posted from agent_settled, and a prompt that
// arrives between agent_end and agent_settled belongs to the NEXT run).
export function claimTurnReplies<T extends TurnReplyInbound>(
	queue: Map<string, T>,
	turn: string | FinalAssistant,
	only?: ReadonlySet<string>,
): TurnReply[] {
	const candidates = [...queue.values()].filter((q) => only === undefined || only.has(q.msg_id));
	const replies = buildTurnReplies(candidates, turn);
	for (const reply of replies) {
		const inbound = queue.get(reply.msg_id);
		if (inbound) inbound.fulfilled = true;
		queue.delete(reply.msg_id);
	}
	return replies;
}
