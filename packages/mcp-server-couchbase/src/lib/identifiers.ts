// src/lib/identifiers.ts

// SIO-667: SQL++ named parameters bind literals, not identifiers. Tools that
// must splice scope/collection/field names (backtick-wrapped) into a query
// validate against this whitelist first to keep the injection surface closed.
// Allows the full Couchbase scope/collection charset (A-Za-z0-9_-%) so real
// names like `archived-orders` pass; the splice sites wrap values in backticks,
// so the load-bearing exclusion is the backtick itself (never in this set).
export const COUCHBASE_IDENTIFIER_RE = /^[A-Za-z0-9_][A-Za-z0-9_%-]*$/;

export function assertIdentifier(value: string, fieldName: string): string {
	if (!COUCHBASE_IDENTIFIER_RE.test(value)) {
		throw new Error(`Invalid identifier for ${fieldName}: must match ${COUCHBASE_IDENTIFIER_RE.toString()}`);
	}
	return value;
}
