// agent/src/llm-json.ts

import type { z } from "zod";

// SIO-1221: the single chokepoint for turning an LLM's prose response into validated
// data. Before this, thirteen nodes each hand-rolled "regex out a JSON blob, JSON.parse
// it, run a Zod schema" -- and only normalizer.ts sanitized control characters, so
// SIO-1219's Sonnet 5 failure mode was live at the other twelve. Route every
// LLM-JSON parse through parseLlmJson() so a model-behaviour change is fixed once.

export type JsonShape = "object" | "array";

export type LlmJsonFailureReason = "no-json" | "malformed-json" | "schema-mismatch";

export type LlmJsonResult<T> = { ok: true; data: T } | { ok: false; reason: LlmJsonFailureReason; message: string };

// Greedy to the LAST closing delimiter, matching the regex every migrated call site
// already used. This tolerates a fenced ```json block (the leading fence is skipped
// because the match starts at the first delimiter) at the cost of mis-capturing a
// response containing two sibling JSON values -- preserved deliberately so the
// migration is behaviour-preserving except for the added sanitization.
const BLOCK_PATTERNS: Record<JsonShape, RegExp> = {
	object: /\{[\s\S]*\}/,
	array: /\[[\s\S]*\]/,
};

const CONTROL_CHAR_ESCAPES: Readonly<Record<string, string>> = {
	"\b": "\\b",
	"\f": "\\f",
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
};

// SIO-1219: Claude Sonnet 5 frequently echoes the user's raw query verbatim into a JSON
// string field (e.g. an extractedMetrics.value copied from a pasted multi-line error
// message) without escaping embedded control characters. JSON.parse correctly rejects a
// raw \n/\r/\t inside a string literal per spec ("bad control character" / "unterminated
// string") -- the LLM's response is malformed JSON, not this parser being too strict.
// Escape control characters that appear INSIDE a string literal (tracking quote state and
// backslash-escapes char-by-char) before parsing, so a normally-shaped envelope with
// unescaped whitespace inside a value no longer fails the whole normalization turn.
//
// SIO-1221: widened from \n/\r/\t to EVERY C0 control character. JSON forbids all of
// U+0000-U+001F unescaped inside a string, and pasted terminal output can carry any of
// them (\f from a page break, U+0007 from a bell, U+001B from an ANSI colour escape) --
// each of which failed exactly as \n did. Moved here from normalizer.ts, where the
// original comment was mis-labelled SIO-1220 (the aggregation-budget ticket).
export function sanitizeJsonControlChars(text: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		if (escaped) {
			result += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && inString) {
			result += ch;
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			result += ch;
			continue;
		}
		if (inString) {
			const mapped = CONTROL_CHAR_ESCAPES[ch];
			if (mapped !== undefined) {
				result += mapped;
				continue;
			}
			const code = ch.codePointAt(0) ?? 0;
			if (code < 0x20) {
				result += `\\u${code.toString(16).padStart(4, "0")}`;
				continue;
			}
		}
		result += ch;
	}
	return result;
}

export function extractJsonBlock(text: string, shape: JsonShape = "object"): string | null {
	return text.match(BLOCK_PATTERNS[shape])?.[0] ?? null;
}

// Never throws. Callers decide how to degrade, because the right fallback is node-specific
// (a deterministic verdict, an empty fragment, a re-ask) and a shared default would be wrong
// somewhere. `reason` is provided so a caller can distinguish "the model said nothing usable"
// from "the model's shape drifted", which is the signal a future model bump needs.
export function parseLlmJson<S extends z.ZodTypeAny>(
	text: string,
	schema: S,
	options: { shape?: JsonShape } = {},
): LlmJsonResult<z.infer<S>> {
	const shape = options.shape ?? "object";
	const block = extractJsonBlock(text, shape);
	if (block === null) {
		return { ok: false, reason: "no-json", message: `no JSON ${shape} in ${text.length}-char response` };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(sanitizeJsonControlChars(block));
	} catch (error) {
		return { ok: false, reason: "malformed-json", message: error instanceof Error ? error.message : String(error) };
	}

	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const message = parsed.error.issues
			.slice(0, 3)
			.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("; ");
		return { ok: false, reason: "schema-mismatch", message };
	}
	return { ok: true, data: parsed.data };
}
