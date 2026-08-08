// agent/src/app-map-baseline.ts
// SIO-1457: deterministic APM call-graph baseline for the per-incident application
// map. The buildApplicationTopology builder is opportunistic -- it only renders
// what the turn's ReAct loop happened to fetch, and a destination-service
// aggregation is not a query the LLM reliably thinks to run (the same failure
// mode SIO-1208 fixed for AWS placement). This module guarantees the runtime
// calls layer on every elastic-scoped turn by invoking ONE bounded
// elasticsearch_search aggregation AFTER the ReAct loop and appending its output
// to toolOutputs where the builder picks it up unchanged. Soft-failing:
// a timeout/absence/error contributes nothing and never affects the answer.
import { readPositiveIntEnv, type ToolOutput } from "@devops-agent/shared";

// Default ON (the sub-agent env-tunable idiom): set APP_MAP_BASELINE_ENABLED=false
// (or 0) to disable. Inert for non-elastic datasources regardless.
export function isAppMapBaselineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.APP_MAP_BASELINE_ENABLED;
	return v !== "false" && v !== "0";
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// CodeRabbit PR #644: the shared helper supplies the fallback and logs invalid
// input; the timer-delay clamp is preserved on top (a value past the setTimeout
// max would fire immediately).
export function appMapBaselineTimeoutMs(): number {
	return Math.min(readPositiveIntEnv("APP_MAP_BASELINE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS), MAX_TIMER_DELAY_MS);
}

// Lookback for the destination aggregation. A fixed recent window (not the
// incident window): the map answers "what does this service topology look like
// NOW", and stale incident windows would silently render week-old call graphs.
const DEFAULT_LOOKBACK = "now-1h";
export function appMapBaselineLookback(env: NodeJS.ProcessEnv = process.env): string {
	const v = env.APP_MAP_BASELINE_LOOKBACK;
	return v && /^now-\d+[mhd]$/.test(v) ? v : DEFAULT_LOOKBACK;
}

const MAX_SOURCE_SERVICES = 100;
const MAX_DESTINATIONS_PER_SERVICE = 50;

export type BaselineInvoke = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

// The exact aggregation the builder's DestinationAggSchema parses: exit spans
// bucketed by source service.name, then by span.destination.service.resource,
// with avg duration and failure counts per pair. size: 0 -- aggregation only.
export function destinationAggregationArgs(lookback: string): Record<string, unknown> {
	return {
		index: "traces-apm*",
		size: 0,
		query: {
			bool: {
				filter: [
					{ term: { "processor.event": "span" } },
					{ exists: { field: "span.destination.service.resource" } },
					{ range: { "@timestamp": { gte: lookback } } },
				],
			},
		},
		aggs: {
			by_source: {
				terms: { field: "service.name", size: MAX_SOURCE_SERVICES },
				aggs: {
					by_destination: {
						terms: { field: "span.destination.service.resource", size: MAX_DESTINATIONS_PER_SERVICE },
						aggs: {
							avg_duration: { avg: { field: "span.duration.us" } },
							error_count: { filter: { term: { "event.outcome": "failure" } } },
						},
					},
				},
			},
		},
	};
}

export type AppMapBaselineSkippedReason = "no-search-tool" | "invoke-failed" | "timed-out";

export interface AppMapBaselineDiagnostics {
	skippedReason?: AppMapBaselineSkippedReason;
}

export interface AppMapBaselineResult {
	outputs: ToolOutput[];
	diagnostics: AppMapBaselineDiagnostics;
}

export async function fetchAppMapBaseline(opts: {
	invoke: BaselineInvoke;
	hasTool: (name: string) => boolean;
	timeoutMs?: number;
	lookback?: string;
}): Promise<AppMapBaselineResult> {
	const diagnostics: AppMapBaselineDiagnostics = {};
	if (!opts.hasTool("elasticsearch_search")) {
		diagnostics.skippedReason = "no-search-tool";
		return { outputs: [], diagnostics };
	}
	const timeoutMs = opts.timeoutMs ?? appMapBaselineTimeoutMs();
	const args = destinationAggregationArgs(opts.lookback ?? appMapBaselineLookback());
	// MCP calls are uncancellable; the race bounds how long WE wait, the call
	// itself is fire-and-forget past the deadline (same model as network-baseline).
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), timeoutMs);
	});
	try {
		const result = await Promise.race([opts.invoke("elasticsearch_search", args), timeout]);
		if (result === "timeout") {
			diagnostics.skippedReason = "timed-out";
			return { outputs: [], diagnostics };
		}
		if (result === undefined) {
			diagnostics.skippedReason = "invoke-failed";
			return { outputs: [], diagnostics };
		}
		return { outputs: [{ toolName: "elasticsearch_search", rawJson: result }], diagnostics };
	} catch {
		diagnostics.skippedReason = "invoke-failed";
		return { outputs: [], diagnostics };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
