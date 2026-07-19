// src/lib/filter.ts

// SIO-1105: the `filter` args on kafka_list_topics / kafka_list_consumer_groups are documented
// regex patterns, but the LLM caller frequently passes a raw name fragment (e.g. "foo(?bar", a
// topic prefix carrying regex metacharacters). new RegExp(filter) then throws a SyntaxError
// ("Invalid regular expression: unrecognized character after (?") that wrap.ts surfaces as a raw
// -32603. compileFilterOrThrow validates the pattern up front and re-throws a TYPED
// InvalidFilterError so the list ops can translate a bad filter into the SIO-1087 structured
// not-found envelope (a routine discovery outcome) instead of a tool malfunction.

export class InvalidFilterError extends Error {
	constructor(
		public readonly filter: string,
		public readonly reason: string,
	) {
		super(`Invalid filter regex ${JSON.stringify(filter)}: ${reason}`);
		this.name = "InvalidFilterError";
	}
}

// SIO-1105: a filter longer than the longest possible Kafka name (249 chars) can never match more
// than a length cap would anyway, and long patterns are the raw material for ReDoS. Cap a bit above
// 249 so legitimate anchored patterns aren't clipped.
const MAX_FILTER_LENGTH = 256;

// SIO-1105: catastrophic-backtracking (ReDoS) guard. A compile-VALID pattern can run in exponential
// time against a non-matching name -- e.g. `^(a+)+$` is ~400ms at 30 chars and effectively unbounded
// toward the 249-char name cap -- and it runs once PER topic/group in the filter loop, so one bad
// filter can wedge the event loop. new RegExp() accepts it, so the SyntaxError catch does not cover
// it. Two shapes are matched:
//   1. NESTED_QUANTIFIER  -- a quantifier (+ * or {n,}) on a group whose body is itself quantified:
//      (X+)+, (X*)*, ([ab]+)+.
//   2. QUANTIFIED_ALTERNATION -- a quantified group containing `|` (overlapping-alternation ReDoS):
//      (a|aa)+, (a|a?)+, (a|b|ab)*. This has no INNER quantifier so shape 1 misses it.
// A single quantifier per group and UNquantified alternation are safe and must still compile:
// ^orders-.*, service-[0-9]+, (prod|staging)-payments, ^T_(dlq|retry)_[a-z]+$.
// NOTE: this is a BEST-EFFORT, deliberately conservative heuristic, not a complete ReDoS oracle --
// regex-based detection cannot catch every pathological shape. It covers the shapes an LLM caller
// realistically emits; the MAX_FILTER_LENGTH cap plus the fact that these are trusted-agent [READ]
// tools (not a public endpoint) bound the residual risk. A complete fix would need a linear-time
// engine (re2), which is out of scope here (adds a native dependency).
const NESTED_QUANTIFIER = /\([^()]*[+*]\)[+*]|\([^()]*[+*]\)\{\d+,\d*\}|\([^()]*\{\d+,\d*\}[^()]*\)[+*]/;
const QUANTIFIED_ALTERNATION = /\([^()]*\|[^()]*\)(?:[+*]|\{\d+,\}|\{\d{3,},?\d*\})/;

export function compileFilterOrThrow(filter: string): RegExp {
	if (filter.length > MAX_FILTER_LENGTH) {
		throw new InvalidFilterError(filter, `filter is too long (${filter.length} > ${MAX_FILTER_LENGTH} chars)`);
	}
	// SIO-1159: LLM callers habitually emit the PCRE inline case-insensitivity flag
	// ("(?i)pattern"), which JS RegExp rejects with "Invalid group" -- run 270378e0
	// lost an iteration to exactly this. Accept the idiom: strip a LEADING (?i) and
	// compile with the "i" flag instead of erroring.
	let pattern = filter;
	let flags = "";
	if (pattern.startsWith("(?i)")) {
		pattern = pattern.slice("(?i)".length);
		flags = "i";
	}
	if (NESTED_QUANTIFIER.test(pattern) || QUANTIFIED_ALTERNATION.test(pattern)) {
		throw new InvalidFilterError(
			filter,
			"pattern risks catastrophic backtracking (ReDoS): a quantified nested/alternation group; simplify it or use 'prefix'",
		);
	}
	try {
		return new RegExp(pattern, flags);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new InvalidFilterError(filter, reason);
	}
}
