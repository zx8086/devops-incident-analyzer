/* src/lib/ftsIndexes.ts */

import type { Bucket, Scope, SearchIndex } from "couchbase";
import { resolveBucket } from "./resolveBucket";

// SIO-1823: shapes below are taken from the live cluster, not from the SDK docs.
// A cluster-level getAllIndexes() there returned 8 indexes of two kinds:
//
//   default.styles.stylesIndex08052025      sourceName "default"  type fulltext-index
//   default.styles.stylesIndexAlias         sourceName ""         type fulltext-alias
//
// Two facts drive this module:
//  1. A scoped index has TWO names. The cluster addresses it by the dotted
//     `<bucket>.<scope>.<name>`; the scope manager addresses it by the bare `<name>`.
//     Passing a bare name to cluster.search() throws IndexNotFoundError -- verified.
//  2. An ALIAS carries an empty sourceName, so nothing may assume that field is set.

// A full index definition is large: the first one captured ran to thousands of lines of
// analyzers, mappings and per-field config. Listing returns this projection instead, and
// capella_get_fts_index_definition fetches the full body for one index on request.
export type FtsIndexSummary = {
	name: string;
	type: string;
	sourceName: string | null;
	// Present only for scope-level indexes, where the tool knows the scope it listed.
	scope?: string;
	// The name to pass back to capella_run_fts_query, which differs by level (see above).
	queryName: string;
	isAlias: boolean;
};

export function summarizeFtsIndex(index: SearchIndex, scope?: string): FtsIndexSummary {
	const type = index.type ?? "unknown";
	return {
		name: index.name,
		type,
		// An alias reports "" rather than omitting the field; normalise to null so the
		// agent reads "no source" instead of an empty string.
		sourceName: index.sourceName ? index.sourceName : null,
		...(scope ? { scope } : {}),
		queryName: index.name,
		isAlias: type.endsWith("alias"),
	};
}

// Both-or-neither: a scope name without a bucket cannot be resolved, and silently
// ignoring it would run a cluster-level call the caller did not ask for.
export function assertScopeArgs(bucket_name?: string, scope_name?: string): string | undefined {
	if (scope_name && !bucket_name) {
		return "scope_name requires bucket_name -- a scope is only addressable within a bucket. Pass both for a scope-level Search index, or neither for a cluster-level one.";
	}
	return undefined;
}

export type FtsTarget =
	| { level: "cluster"; manager: ReturnType<Bucket["cluster"]["searchIndexes"]> }
	| { level: "scope"; manager: ReturnType<Scope["searchIndexes"]>; scope: Scope; scopeName: string };

// Resolves which Search index manager answers for the requested level. Kept in one
// place because all three FTS tools make the same cluster-vs-scope choice, and the
// wrong choice fails as IndexNotFoundError rather than as a visible argument error.
export function resolveFtsTarget(bucket: Bucket, bucket_name?: string, scope_name?: string): FtsTarget {
	if (scope_name) {
		const scope = resolveBucket(bucket, bucket_name).scope(scope_name);
		return { level: "scope", manager: scope.searchIndexes(), scope, scopeName: scope_name };
	}
	return { level: "cluster", manager: bucket.cluster.searchIndexes() };
}
