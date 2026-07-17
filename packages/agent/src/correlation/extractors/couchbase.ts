// packages/agent/src/correlation/extractors/couchbase.ts
import type { CouchbaseFindings, CouchbaseSlowQuery, ResolvedIdentifiers, ToolOutput } from "@devops-agent/shared";
import { CouchbaseSlowQuerySchema } from "@devops-agent/shared";
import { matchesFocus } from "../focus-match.ts";

// SIO-1138: when nothing matches the focus, surface the top rows anyway (flagged
// unscoped) instead of an empty card. Rows arrive pre-sorted by avg service time
// from n1qlLongestRunningQueries, so a head slice keeps the worst offenders.
const UNSCOPED_FALLBACK_LIMIT = 5;

// SIO-1138: flatten the resolveIdentifiers couchbase block (SIO-1084) into the
// scope/collection names statements can actually reference. The block enumerates
// the ENTIRE visible tree (deliberately unfiltered), so callers must intersect
// with the focus before treating a keyspace as incident-relevant.
export function collectCouchbaseKeyspaces(resolved: ResolvedIdentifiers | undefined): string[] {
	const cb = resolved?.couchbase;
	if (!cb) return [];
	const names = new Set<string>();
	for (const [scope, collections] of Object.entries(cb.scopes)) {
		names.add(scope);
		for (const c of collections) names.add(c);
	}
	for (const scopes of Object.values(cb.otherBucketScopes ?? {})) {
		for (const [scope, collections] of Object.entries(scopes)) {
			names.add(scope);
			for (const c of collections) names.add(c);
		}
	}
	return Array.from(names);
}

// SIO-1030: focusServices scopes slow queries to the incident (strict drop).
// SIO-1138: N1QL statements name buckets/collections, not services, so strict
// service-name matching structurally emptied the card on focused investigations.
// Two-stage recovery: (1) also keep statements referencing a resolved keyspace
// whose NAME matches a focus service (bridges e.g. prana-order-service -> orders);
// (2) when scoping still yields nothing, fall back to the top rows flagged
// `unscoped: true` -- honest signal, never silently empty. matchesFocus
// short-circuits show-all on empty focus, so unfocused turns are unchanged.
export function extractCouchbaseFindings(
	outputs: ToolOutput[],
	focusServices: string[] = [],
	resolvedKeyspaces: string[] = [],
): CouchbaseFindings {
	// Keyspaces are only incident-relevant when their own name matches the focus;
	// matching against the full unfiltered tree would quietly un-scope the card.
	const focusKeyspaces =
		focusServices.length > 0 ? resolvedKeyspaces.filter((k) => matchesFocus(k, focusServices)) : [];

	const scoped: CouchbaseSlowQuery[] = [];
	const all: CouchbaseSlowQuery[] = [];

	for (const o of outputs) {
		if (o.toolName !== "capella_get_longest_running_queries") continue;
		if (!Array.isArray(o.rawJson)) continue;
		for (const q of o.rawJson) {
			const parsed = CouchbaseSlowQuerySchema.safeParse(q);
			if (!parsed.success) continue;
			all.push(parsed.data);
			const stmt = parsed.data.statement;
			if (matchesFocus(stmt, focusServices) || focusKeyspaces.some((k) => matchesFocus(stmt, [k]))) {
				scoped.push(parsed.data);
			}
		}
	}

	if (scoped.length > 0) return { slowQueries: scoped };
	if (focusServices.length === 0 || all.length === 0) return {};

	// Unscoped fallback: keep the analyzer's own introspection noise out of it.
	const fallback = all.filter((q) => !/system:/i.test(q.statement)).slice(0, UNSCOPED_FALLBACK_LIMIT);
	return fallback.length > 0 ? { slowQueries: fallback, unscoped: true } : {};
}
