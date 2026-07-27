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
	// Preference order, strongest first. The successful-enriched tier is load-bearing:
	// extractFindings copies the merged findings onto EVERY row of a dataSourceId group,
	// including rows whose sub-agent ERRORED, so plain array order could hand back an error
	// row that happens to carry findings. Every caller in rules.ts then hits its
	// `status !== "success"` guard and returns `{}` -- discarding findings that were present
	// all along (CodeRabbit, PR #494). A multi-estate turn where one estate fails is exactly
	// when that happens, which is the case this whole change exists to get right.
	let successEnriched: DataSourceResult | undefined;
	let anyEnriched: DataSourceResult | undefined;
	let lastMatch: DataSourceResult | undefined;
	for (const r of results) {
		if (r.dataSourceId !== dataSourceId) continue;
		lastMatch = r;
		if (r[findingsKey] === undefined) continue;
		anyEnriched = r;
		if (r.status === "success") successEnriched = r;
	}
	return successEnriched ?? anyEnriched ?? lastMatch;
}
