// packages/mcp-server-elastic/src/utils/searchRequestOptions.ts

// SIO-708: Per-request `TransportRequestOptions` for `elasticsearch_search`. The shared client
// uses requestTimeout=30s + maxRetries=3 (applied per-attempt), which trips when the sub-agent
// fans out 4 parallel aggregation-heavy queries against 1B-doc indices (styles-v3 trace
// 019e12a4-fdc8...): all 4 hit the 30s ceiling within 6ms of each other, while the same
// queries issued sequentially completed in 5-7s. Lift the per-call ceiling to 60s and drop
// retries to 0 so a single slow aggregation doesn't burn 4 attempts × 30s of wall time.
//
// Defaults: 60000ms timeout (2x the shared client default; covers the 5-7s heavy aggregations
// with headroom even when contended), 0 retries (the SDK's automatic retry on POST _search
// silently amplifies wall time without helping; the agent will choose to retry at the ReAct
// level if needed). Tunable via env vars for eval-driven sizing, mirroring the
// SUBAGENT_TOOL_RESULT_CAP_BYTES / ELASTIC_DISCOVERY_REQUEST_TIMEOUT_MS pattern.
//
// Use this for the elasticsearch_search tool only. Pass the result as the second argument to
// `esClient.search(params, opts)`. The schema in config/schemas.ts caps the client-level
// requestTimeout at 120000ms; ELASTIC_SEARCH_REQUEST_TIMEOUT_MS is independent and not bound
// by that cap, but values much higher than ~120s will hold the ReAct loop hostage on a single
// tool call and should be avoided.

const SEARCH_REQUEST_TIMEOUT_DEFAULT_MS = 60000;
const SEARCH_MAX_RETRIES_DEFAULT = 0;

export interface SearchRequestOptions {
	requestTimeout: number;
	maxRetries: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (raw == null || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}

// Retries accept 0 as a valid override (the default), but reject negative/non-numeric.
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
	if (raw == null || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Math.floor(parsed);
}

export function getSearchRequestOptions(env: NodeJS.ProcessEnv = process.env): SearchRequestOptions {
	return {
		requestTimeout: parsePositiveInt(env.ELASTIC_SEARCH_REQUEST_TIMEOUT_MS, SEARCH_REQUEST_TIMEOUT_DEFAULT_MS),
		maxRetries: parseNonNegativeInt(env.ELASTIC_SEARCH_MAX_RETRIES, SEARCH_MAX_RETRIES_DEFAULT),
	};
}
