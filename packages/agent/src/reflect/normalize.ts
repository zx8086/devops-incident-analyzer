// packages/agent/src/reflect/normalize.ts
//
// SIO-1834 (A2): adapter output -> scanner input. Adds a message index, clips bulky parts,
// and redacts every excerpt that can reach a report.
import { redactPiiContent } from "@devops-agent/shared";
import type { NormalizedPart, NormalizedSession, RawPart, RawSession } from "./schema.ts";

export const TOOL_RESULT_CLIP = 600;

// One-way, and never rendered: it exists so two calls that differ only in a value redaction
// would flatten can still be told apart.
function digest(text: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(String(text ?? ""))
		.digest("hex")
		.slice(0, 16);
}

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
// Redaction is stable, so it never makes two identical calls look DIFFERENT. The inverse is
// the hazard: every value of one PII class collapses to the same placeholder, so a call for
// alice@corp.com and one for bob@corp.com become byte-identical and read as a repeat
// (verified: both redact to {"user":"[EMAIL_REDACTED]"}).
//
// So a tool call carries a digest of its input taken BEFORE redaction. Matching uses that;
// the report still shows only the redacted text. Nothing unredacted survives normalization,
// and the digest is one-way.
function normalizePart(part: RawPart): NormalizedPart {
	if (part.type === "tool_result") {
		return { ...part, content: redactPiiContent(clip(part.content, TOOL_RESULT_CLIP)) };
	}
	if (part.type === "text") {
		return { ...part, text: redactPiiContent(part.text) };
	}
	return { ...part, input: redactPiiContent(part.input), inputDigest: digest(part.input) };
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
