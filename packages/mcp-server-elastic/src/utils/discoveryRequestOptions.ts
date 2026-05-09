// packages/mcp-server-elastic/src/utils/discoveryRequestOptions.ts

// SIO-690: Per-request `TransportRequestOptions` for discovery/metadata ES SDK calls. The shared
// client uses requestTimeout=30s + maxRetries=3 (correct for search/write paths) which is
// applied per-attempt -- one transparent retry on a transient pool failure produced the 60013ms
// stall on `elasticsearch_get_mappings` in the SIO-689 trace. Discovery calls (cat indices,
// cluster health, get_mappings, etc.) should fail fast: the LLM is better served by an immediate
// error it can route around than by a silent ~60s wait.
//
// Defaults: 8000ms timeout (2x the observed ~4s `cat indices` baseline on `eu-b2b`), 0 retries
// (a single fast-fail). Tunable via env vars for eval-driven sizing without redeploys, mirroring
// the SUBAGENT_TOOL_RESULT_CAP_BYTES / SUBAGENT_ELASTIC_RECURSION_LIMIT pattern.
//
// Use this for discovery/metadata reads only (no documents, no writes, no aggregation searches).
// Pass the result as the second argument to `esClient.<api>.<method>(params, opts)`.
//
// On timeout the underlying ES SDK throws an Error whose message starts with "Request timed out".
// The headline tool (elasticsearch_get_mappings) maps this to ErrorCode.RequestTimeout via its
// per-tool error helper. Other discovery tools either already have a `timeout` branch or surface
// the timeout through their generic execution error -- the SDK message is preserved in either
// case so the LLM agent can route around the failed call.

const DISCOVERY_REQUEST_TIMEOUT_DEFAULT_MS = 8000;
const DISCOVERY_MAX_RETRIES_DEFAULT = 0;

export interface DiscoveryRequestOptions {
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

export function getDiscoveryRequestOptions(env: NodeJS.ProcessEnv = process.env): DiscoveryRequestOptions {
	return {
		requestTimeout: parsePositiveInt(env.ELASTIC_DISCOVERY_REQUEST_TIMEOUT_MS, DISCOVERY_REQUEST_TIMEOUT_DEFAULT_MS),
		maxRetries: parseNonNegativeInt(env.ELASTIC_DISCOVERY_MAX_RETRIES, DISCOVERY_MAX_RETRIES_DEFAULT),
	};
}
