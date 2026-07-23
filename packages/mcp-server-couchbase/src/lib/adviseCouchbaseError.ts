// src/lib/adviseCouchbaseError.ts
// SIO-1162: copy-paste remediation the agent can act on in one shot, keyed off the
// SDK-classified kind. Mirrors the AWS wrap.ts per-kind advice model and the SIO-1159
// widen-window advice. The agent reads _error.advice structurally, so a no-index becomes a
// routine "filter on the leading key" steer instead of a silent re-issue loop, and a
// bad-query becomes a "fix the FROM clause" steer. Returns undefined for kinds with no
// useful copy-paste hint (transient/auth/not-found are self-explanatory or non-actionable).

import type { ToolErrorKind } from "@devops-agent/shared";

export function adviseCouchbaseError(kind: ToolErrorKind): string | undefined {
	switch (kind) {
		case "no-index":
			return (
				"This collection has no queryable index for that predicate (N1QL 4000). Do NOT retry SELECT * as-is. " +
				"Lead your WHERE clause on the index's first key field, or fetch by key with capella_get_document_by_id " +
				"or a `USE KEYS` clause. capella_get_system_indexes lists each collection's index_key fields. " +
				'A leading-wildcard LIKE ("%...%") is a common cause -- it defeats index range scans; ' +
				'use a prefix LIKE ("abc%"), an exact match on an indexed field, or fetch by document key instead.'
			);
		case "bad-query":
			return (
				"The SQL++ statement failed to parse/plan. Fix the statement -- do not re-issue it unchanged. " +
				"Under scope context reference ONLY the collection name in FROM (pass the scope via scope_name); " +
				"double-quote string literals, backtick reserved-word identifiers, and confirm referenced fields exist."
			);
		default:
			return undefined;
	}
}
