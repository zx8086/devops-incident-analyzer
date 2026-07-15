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

export function compileFilterOrThrow(filter: string): RegExp {
	try {
		return new RegExp(filter);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new InvalidFilterError(filter, reason);
	}
}
