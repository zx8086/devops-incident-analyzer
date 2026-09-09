// extensions/turnReply.ts
import { extractJsonPayload } from "./jsonPayload.ts";

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
	if (turn.text.trim() === "") return "empty reply: no assistant text";
	return null;
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
			const parsed = extractJsonPayload(lastAssistantText);
			if (parsed === undefined) {
				replies.push({ msg_id: inbound.msg_id, response: null, error: "response not valid JSON" });
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
