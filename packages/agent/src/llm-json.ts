// agent/src/llm-json.ts

// SIO-1233: promoted from `import type` -- withKeyAliases needs z.preprocess as a value.
// This module stays free of every OTHER dependency, and in particular must never gain an
// LLM invoke: the corrective retry lives in llm-json-retry.ts precisely to keep the parser
// pure and synchronously testable.
import { z } from "zod";

// SIO-1221: the single chokepoint for turning an LLM's prose response into validated
// data. Before this, thirteen nodes each hand-rolled "regex out a JSON blob, JSON.parse
// it, run a Zod schema" -- and only normalizer.ts sanitized control characters, so
// SIO-1219's Sonnet 5 failure mode was live at the other twelve. Route every
// LLM-JSON parse through parseLlmJson() so a model-behaviour change is fixed once.

export type JsonShape = "object" | "array";

export type LlmJsonFailureReason = "no-json" | "malformed-json" | "schema-mismatch";

// SIO-1233: `observedKeys` carries the top-level key NAMES of the payload that failed
// validation. Without it an envelope drift is undiagnosable: no call site may log the
// body (aws-estate-router.ts:200-205 establishes that raw model output echoes user
// hostnames, IPs and emails), so "dataSources: expected array, received undefined" told
// us a key was missing but never which keys the model actually sent. Names only, capped
// and truncated -- a key NAME is model-authored schema vocabulary, not user content.
export type LlmJsonResult<T> =
	| { ok: true; data: T }
	| { ok: false; reason: LlmJsonFailureReason; message: string; observedKeys?: readonly string[] };

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
	if (parsed.success) return { ok: true, data: parsed.data };

	// SIO-1233: envelope drift. The model returned valid JSON whose payload sits one level
	// down under a container key it invented ({"entities": {...}}, {"result": {...}}). Retry
	// exactly ONE unwrap, and only here on the already-failing path -- no parse that already
	// succeeds can change behaviour, at any of the 13 call sites.
	//
	// Depth 1 and single-key only, both deliberate: a two-level wrapper is drift severe enough
	// that the corrective retry should own it, and unbounded unwrapping would eventually
	// descend INTO a legitimate nested payload and validate the wrong sub-object.
	const unwrapped = unwrapSingleKeyEnvelope(raw);
	if (unwrapped !== undefined) {
		const retry = schema.safeParse(unwrapped);
		if (retry.success) return { ok: true, data: retry.data };
	}

	// The ORIGINAL error, never the unwrap's. Reporting the unwrapped failure would describe
	// a shape the model never sent and send the next debugger after the wrong drift.
	const message = formatIssues(parsed.error);
	return { ok: false, reason: "schema-mismatch", message, observedKeys: collectObservedKeys(raw) };
}

function formatIssues(error: z.ZodError): string {
	return error.issues
		.slice(0, 3)
		.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
		.join("; ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Returns the inner value only for a single-key object whose value is itself an object or
// array. A scalar-valued single key ({"answer": "yes"}) is NOT an envelope -- unwrapping it
// would hand the schema a bare string and turn a clear "expected object" into a confusing one.
function unwrapSingleKeyEnvelope(raw: unknown): unknown {
	if (!isPlainObject(raw)) return undefined;
	const keys = Object.keys(raw);
	if (keys.length !== 1) return undefined;
	const inner = raw[keys[0] as string];
	return isPlainObject(inner) || Array.isArray(inner) ? inner : undefined;
}

const MAX_OBSERVED_KEYS = 10;
const MAX_OBSERVED_KEY_LENGTH = 40;

function collectObservedKeys(raw: unknown): readonly string[] | undefined {
	if (!isPlainObject(raw)) return undefined;
	return Object.keys(raw)
		.slice(0, MAX_OBSERVED_KEYS)
		.map((k) => (k.length > MAX_OBSERVED_KEY_LENGTH ? `${k.slice(0, MAX_OBSERVED_KEY_LENGTH)}...` : k));
}

// SIO-1233: tolerate a model spelling a top-level key snake_case (or by a synonym) instead of
// the camelCase the schema names. Applied per-schema with an EXPLICIT alias map rather than as
// a blanket snake_case->camelCase rewrite, because a global rewrite corrupts real data here:
// ExtractionSchema.toolActions is a z.record keyed by model-authored datasource ids, and
// extractedMetrics[].name is free text -- both would have their keys mangled.
//
// The canonical key always wins. If the model sends BOTH `dataSources` and `data_sources`, the
// one the schema asked for is authoritative and the alias is ignored, so a model that half-drifts
// cannot overwrite the field it got right.
export function withKeyAliases<S extends z.ZodTypeAny>(schema: S, aliases: Readonly<Record<string, string>>) {
	return z.preprocess((value: unknown) => {
		if (!isPlainObject(value)) return value;
		let patched: Record<string, unknown> | undefined;
		for (const [alias, canonical] of Object.entries(aliases)) {
			if (value[canonical] !== undefined || value[alias] === undefined) continue;
			patched ??= { ...value };
			patched[canonical] = value[alias];
		}
		return patched ?? value;
	}, schema);
}
