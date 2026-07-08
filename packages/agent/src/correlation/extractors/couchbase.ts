// packages/agent/src/correlation/extractors/couchbase.ts
import type { CouchbaseFindings, CouchbaseSlowQuery, ToolOutput } from "@devops-agent/shared";
import { CouchbaseSlowQuerySchema } from "@devops-agent/shared";
import { matchesFocus } from "../focus-match.ts";

// SIO-1030: focusServices scopes slow queries to the incident. Strict drop —
// a query is kept only when its statement text references a focus service
// (matchesFocus short-circuits show-all on empty focus). NOTE: a slow-query
// statement often names a bucket/collection, not the focus *service*, so on a
// focused investigation this can legitimately empty the card. That is the honest
// result of the strict policy; extract-findings.ts logs a droppedAll warn so the
// over-scope is observable.
export function extractCouchbaseFindings(outputs: ToolOutput[], focusServices: string[] = []): CouchbaseFindings {
	const slowQueries: CouchbaseSlowQuery[] = [];

	for (const o of outputs) {
		if (o.toolName !== "capella_get_longest_running_queries") continue;
		if (!Array.isArray(o.rawJson)) continue;
		for (const q of o.rawJson) {
			const parsed = CouchbaseSlowQuerySchema.safeParse(q);
			if (!parsed.success) continue;
			if (!matchesFocus(parsed.data.statement, focusServices)) continue;
			slowQueries.push(parsed.data);
		}
	}

	return slowQueries.length > 0 ? { slowQueries } : {};
}
