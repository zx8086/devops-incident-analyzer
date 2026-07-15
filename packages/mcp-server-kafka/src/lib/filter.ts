// src/lib/filter.ts

// SIO-1105: the `filter` args on kafka_list_topics / kafka_list_consumer_groups are documented
// regex patterns, but the LLM caller frequently passes a raw name fragment (e.g. "foo(?bar", a
// topic prefix carrying regex metacharacters). new RegExp(filter) then throws a SyntaxError
// ("Invalid regular expression: unrecognized character after (?") that wrap.ts surfaces as a raw
// -32603. compileFilterOrThrow validates the pattern up front and re-throws a TYPED
// InvalidFilterError so the list ops can translate a bad filter into the SIO-1087 structured
// no-data envelope (a routine discovery outcome) instead of a tool malfunction.

export class InvalidFilterError extends Error {
	constructor(
		public readonly filter: string,
		public readonly reason: string,
	) {
		super(`Invalid filter regex ${JSON.stringify(filter)}: ${reason}`);
		this.name = "InvalidFilterError";
	}
}

// SIO-1105: a filter longer than the longest possible Kafka name (249 chars) can never match
// more than a length cap would anyway, and long patterns are the raw material for ReDoS. Cap a bit
// above 249 so legitimate anchored patterns aren't clipped.
const MAX_FILTER_LENGTH = 256;

// SIO-1105: catastrophic-backtracking (ReDoS) guard. A compile-VALID pattern like `^(a+)+$` runs in
// exponential time against a non-matching name -- ~400ms at 30 chars, effectively unbounded toward
// the 249-char name cap, and it runs once PER topic/group in the filter loop, so one bad filter can
// wedge the event loop. new RegExp() accepts it, so the SyntaxError catch does not cover it. This
// matches the canonical nested-quantifier shape: a quantifier (+ * or {n,}) applied to a group whose
// body itself ends in a quantifier -- (X+)+, (X*)*, ([ab]+)+ etc. A single quantifier per group
// (^orders-.*, service-[0-9]+, (prod|staging)-x) is safe and must still compile.
const NESTED_QUANTIFIER = /\([^()]*[+*]\)[+*]|\([^()]*[+*]\)\{\d+,\d*\}|\([^()]*\{\d+,\d*\}[^()]*\)[+*]/;

export function compileFilterOrThrow(filter: string): RegExp {
	if (filter.length > MAX_FILTER_LENGTH) {
		throw new InvalidFilterError(filter, `filter is too long (${filter.length} > ${MAX_FILTER_LENGTH} chars)`);
	}
	if (NESTED_QUANTIFIER.test(filter)) {
		throw new InvalidFilterError(
			filter,
			"pattern has nested quantifiers that risk catastrophic backtracking (ReDoS); simplify it or use 'prefix'",
		);
	}
	try {
		return new RegExp(filter);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new InvalidFilterError(filter, reason);
	}
}
