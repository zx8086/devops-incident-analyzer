// src/lib/identifiers.ts

// SIO-667: SQL++ named parameters bind literals, not identifiers. Tools that
// must splice scope/collection/field names (backtick-wrapped) into a query
// validate against this whitelist first to keep the injection surface closed.
// Tight regex (no hyphens) -- accepts the canonical _default scope/collection
// and standard documentType-style field names.
export const COUCHBASE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(value: string, fieldName: string): string {
	if (!COUCHBASE_IDENTIFIER_RE.test(value)) {
		throw new Error(`Invalid identifier for ${fieldName}: must match ${COUCHBASE_IDENTIFIER_RE.toString()}`);
	}
	return value;
}
