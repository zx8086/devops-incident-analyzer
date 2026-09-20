// extensions/jsonPayload.ts

// Schema-constrained replies rarely arrive as bare JSON: models wrap the
// payload in a markdown fence or add prose around it. Try strict parse, then
// every fenced block, then each TOP-LEVEL balanced object/array in order of
// appearance. Returns undefined when nothing in the text parses.
//
// SIO-1804, two defects found by reproducing them:
//
//   1. A candidate that failed to parse was DESCENDED INTO. The old code tried the
//      first `{...}`, and on failure ran a second pass for the first `[...]`, which
//      for a verdict is the `claims` array INSIDE the broken object. That inner
//      fragment was returned as if it were the whole reply: silent garbage that the
//      sender then rejected as "misses the schema". A span that fails is now skipped
//      whole, and the scan continues after it, so prose like "the {cluster} state"
//      before the payload no longer hides the payload either.
//   2. Raw control characters inside a string (a literal newline or tab in a long
//      summary or evidence text) are invalid JSON, and the models emit them (SIO-1219
//      on the analyzer side). Each candidate is retried with those escaped. This
//      extension is bundled standalone for Pi, so the repair is local rather than
//      imported from packages/agent/src/llm-json.ts, which it mirrors.
//
// Deliberately NOT repaired: trailing commas, single quotes, comments. Those now
// fail loudly (undefined) instead of yielding a fragment.

const FAILED = Symbol("not json");

const CONTROL_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

// Escapes C0 control characters that appear INSIDE a string literal.
function escapeControlCharsInStrings(text: string): string {
	let out = "";
	let inStr = false;
	let esc = false;
	for (const ch of text) {
		if (esc) {
			out += ch;
			esc = false;
		} else if (ch === "\\" && inStr) {
			out += ch;
			esc = true;
		} else if (ch === '"') {
			inStr = !inStr;
			out += ch;
		} else if (inStr && (ch.codePointAt(0) ?? 0x20) < 0x20) {
			out += CONTROL_ESCAPES[ch] ?? `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
		} else {
			out += ch;
		}
	}
	return out;
}

function parseLenient(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch {}
	try {
		return JSON.parse(escapeControlCharsInStrings(candidate));
	} catch {}
	return FAILED;
}

// SIO-1833: why the payload would not parse, for the error the operator reads.
// A separate pass rather than a second return value from extractJsonPayload: the
// extractor is the hot path and its contract (value | undefined) is relied on by
// every caller, while this runs once, only after a failure has already happened.
//
// The MESSAGE is the whole signal. Bun's JSON.parse names the defect precisely
// ("Unexpected comma at the end of array expression", "Single quotes (') are not
// allowed in JSON"), which is exactly what the 6288-char prd failure did not say.
// Its `line`/`column` are NOT used: a model emits the payload as one long line, and
// on a real 1350-char sample Bun reported line 5 column 12, pointing at the start of
// the document rather than the fault. A window derived from that would mislead.
export function jsonParseFailure(text: string): string | null {
	const t = text.trim();
	const reasons: string[] = [];
	const record = (label: string, candidate: string): boolean => {
		try {
			JSON.parse(candidate);
			return true;
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			// "JSON Parse error: " prefixes every Bun message and carries no information
			// in a field already called "parse error". Dropped to keep the whole error
			// inside the budget SIO-1804 pins (it rides the hub message and the digest).
			const message = raw.replace(/^JSON Parse error:\s*/i, "");
			// Schema-derived parser text only; never the candidate itself.
			reasons.push(label ? `${label}: ${message}` : message);
			return false;
		}
	};

	const fences = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
	// A FENCED payload always fails as a whole on the backticks, and that reason is
	// pure noise next to the real one inside the fence. Report the whole-document
	// attempt only when there is no fence to blame.
	if (fences.length === 0) {
		// No fence to disambiguate, so the label would say nothing.
		if (record("", t)) return null;
	} else {
		for (const [index, fence] of fences.entries()) {
			const label = fences.length === 1 ? "in fence" : `in fence ${index + 1}`;
			if (record(label, (fence[1] ?? "").trim())) return null;
		}
	}
	// One reason is the useful case; more than two is noise, and the first failure
	// is the one that describes the payload the model actually meant to send.
	return reasons.slice(0, 2).join("; ");
}

// Index of the bracket that closes the one at `start`, string-aware; -1 if unbalanced.
function balancedEnd(t: string, start: number): number {
	const open = t[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < t.length; i++) {
		const c = t[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === open) depth++;
		else if (c === close && --depth === 0) return i;
	}
	return -1;
}

export function extractJsonPayload(text: string): unknown {
	const t = text.trim();
	const whole = parseLenient(t);
	if (whole !== FAILED) return whole;

	for (const fence of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		const fenced = parseLenient((fence[1] ?? "").trim());
		if (fenced !== FAILED) return fenced;
	}

	let i = 0;
	while (i < t.length) {
		const rest = t.slice(i).search(/[{[]/);
		if (rest < 0) break;
		const start = i + rest;
		const end = balancedEnd(t, start);
		if (end < 0) break;
		const parsed = parseLenient(t.slice(start, end + 1));
		if (parsed !== FAILED) return parsed;
		i = end + 1;
	}
	return undefined;
}
