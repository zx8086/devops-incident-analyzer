// packages/agent/src/reflect/normalize.ts
//
// SIO-1834 (A2): adapter output -> scanner input. Adds a message index, clips bulky parts,
// and redacts every excerpt that can reach a report.
import { redactPiiContent } from "@devops-agent/shared";
import type { NormalizedSession, RawPart, RawSession } from "./schema.ts";

export const TOOL_RESULT_CLIP = 600;

// Keep the head and the tail: an error states itself at the head, while the status/exit
// detail that says whether it mattered sits at the tail. Clipping to the head alone loses
// the second half of that evidence.
export function clip(text: string, limit: number): string {
	const value = String(text ?? "");
	if (!limit || value.length <= limit) return value;
	const head = Math.ceil(limit * 0.6);
	return `${value.slice(0, head)}...${value.slice(value.length - (limit - head))}`;
}

// Prose and tool-call input are never CLIPPED: the scanner parses the input JSON (a clipped
// one will not parse) and compares it byte-for-byte to detect a repeated call, and an elided
// sentence breaks the user-reaction detectors that read whole turns.
//
// They are still REDACTED. Every one of these fields can reach a report: user text becomes
// `Scan.request.text` and the evidence of a user-reaction signal, and tool arguments become
// the evidence of a repeat-call. Redacting only tool results would leave an address or a
// phone number in the opening request quoted verbatim in a findings report.
//
// Redaction is stable for a given input, so it happens BEFORE the scanner compares anything
// and cannot make two identical calls look different.
function normalizePart(part: RawPart): RawPart {
	if (part.type === "tool_result") {
		return { ...part, content: redactPiiContent(clip(part.content, TOOL_RESULT_CLIP)) };
	}
	if (part.type === "text") {
		return { ...part, text: redactPiiContent(part.text) };
	}
	return { ...part, input: redactPiiContent(part.input) };
}

export function normalizeSession(session: RawSession): NormalizedSession {
	return {
		source: session.meta,
		messages: session.messages.map((message, index) => ({
			...message,
			index,
			parts: message.parts.map(normalizePart),
		})),
	};
}
