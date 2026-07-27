// agent/src/correlation/select-result.ts
// SIO-1245: pick the DataSourceResult row a correlation reader should use.
//
// `dataSourceResults` uses an APPEND reducer (state.ts) -- `[...prev, ...next]`, reset only
// on an empty array. extractFindings returns the FULL mapped array, so its update is appended
// rather than replacing: after it runs the channel holds every row TWICE, the pre-extraction
// (findings-less) copies FIRST. Every `.find(r => r.dataSourceId === x)` in rules.ts/engine.ts
// therefore matched a row with no typed findings, and the SIO-764/SIO-842 typed-finding rules
// read `{}` on every turn. Verified against the real reducer: 2 AWS estate rows in, 4 rows out,
// `.find()` landing on `findings=NO`.
//
// The append is load-bearing and must NOT be "fixed" in the reducer: summarizeFirstAttempts
// (SIO-691, alignment.ts) distinguishes a failed first attempt from its retry by scanning the
// accumulated rows, and getRetryTargets dedupes errored ids precisely because "results
// accumulate across retries". Collapsing the channel would silently delete that evidence.
//
// So the fix belongs at the reader: prefer the LAST row that actually carries the findings
// key, which is the enriched copy. Falling back to the last matching row keeps behaviour
// unchanged for a datasource extractFindings never enriched, and keeps correlationFetch rows
// (appended AFTER extractFindings, with no findings of their own) from winning.

import type { DataSourceResult } from "@devops-agent/shared";

// Keys extractFindings writes onto a row. Constrained to those so a caller cannot ask for an
// unrelated field and silently get last-row-wins semantics it did not intend.
export type FindingsKey =
	| "kafkaFindings"
	| "awsFindings"
	| "couchbaseFindings"
	| "elasticFindings"
	| "gitlabFindings"
	| "atlassianFindings"
	| "orbitFindings";

export function selectResultWithFindings(
	results: DataSourceResult[],
	dataSourceId: string,
	findingsKey: FindingsKey,
): DataSourceResult | undefined {
	let enriched: DataSourceResult | undefined;
	let lastMatch: DataSourceResult | undefined;
	for (const r of results) {
		if (r.dataSourceId !== dataSourceId) continue;
		lastMatch = r;
		if (r[findingsKey] !== undefined) enriched = r;
	}
	return enriched ?? lastMatch;
}
