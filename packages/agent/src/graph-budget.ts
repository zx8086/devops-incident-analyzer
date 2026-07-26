// agent/src/graph-budget.ts
import type { RunnableConfig } from "@langchain/core/runnables";

// SIO-1110: AbortSignal exposes no readable deadline, so the graph call sites
// (apps/web/src/lib/server/agent.ts) thread an explicit epoch-ms timestamp in
// config.configurable alongside the signal. configurable (not graph state) so
// the topic-shift resume path, which arms a fresh signal, gets a matching fresh
// deadline instead of a stale checkpointed one. Absent (direct invocation,
// tests) means "no budget accounting" -- legacy behavior.
export const GRAPH_DEADLINE_KEY = "graphDeadlineAt";

// Wall-clock runway kept for aggregate + extractFindings + validate + mitigation
// after the fan-out/retry phase. Sized from the incident trace: aggregation's
// LLM call needs ~30-60s; 120s leaves margin for the downstream nodes.
const GRAPH_BUDGET_RESERVE_MS_DEFAULT = 120_000;
// Smallest retry window still worth dispatching: less than a minute of sub-agent
// runtime rarely recovers a source that just burned its full timeout.
const GRAPH_BUDGET_MIN_RETRY_MS_DEFAULT = 60_000;

// Both parsers require >= 1: a sub-millisecond value like "0.5" would pass a
// plain > 0 check and then floor to 0, silently disabling the threshold.
export function getGraphBudgetReserveMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.GRAPH_BUDGET_RESERVE_MS;
	if (raw == null || raw === "") return GRAPH_BUDGET_RESERVE_MS_DEFAULT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 1) return GRAPH_BUDGET_RESERVE_MS_DEFAULT;
	return Math.floor(parsed);
}

export function getGraphBudgetMinRetryMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.GRAPH_BUDGET_MIN_RETRY_MS;
	if (raw == null || raw === "") return GRAPH_BUDGET_MIN_RETRY_MS_DEFAULT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 1) return GRAPH_BUDGET_MIN_RETRY_MS_DEFAULT;
	return Math.floor(parsed);
}

export function getGraphDeadlineAt(config?: RunnableConfig): number | undefined {
	const value = config?.configurable?.[GRAPH_DEADLINE_KEY];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// A retry is affordable only if, after a minimally useful retry window, the
// aggregation reserve still survives. Undefined deadline = no accounting.
export function hasRetryBudget(
	deadlineAt: number | undefined,
	now: number = Date.now(),
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (deadlineAt === undefined) return true;
	return deadlineAt - now >= getGraphBudgetReserveMs(env) + getGraphBudgetMinRetryMs(env);
}

// min(base, remaining - reserve), floored at 1s so AbortSignal.timeout never
// receives a non-positive value.
export function capSubAgentTimeoutMs(
	baseTimeoutMs: number,
	deadlineAt: number | undefined,
	now: number = Date.now(),
	env: NodeJS.ProcessEnv = process.env,
): number {
	if (deadlineAt === undefined) return baseTimeoutMs;
	const affordable = deadlineAt - now - getGraphBudgetReserveMs(env);
	return Math.max(1_000, Math.min(baseTimeoutMs, affordable));
}

// SIO-1221: aggregate()'s LLM call is deliberately exempt from the per-role
// deadline (llm.ts ROLE_DEADLINES_MS.aggregator = 0) and relies solely on the
// shared graph-wide AbortSignal. A slow fan-out (e.g. an alignment retry that
// burns its full timeout) can leave less runway than aggregation actually
// needs, so the hard AbortSignal kills the LLM call mid-generation with no
// answer at all. This checks the ACTUAL remaining time (not a static guess)
// against a floor sized for the fallback path itself: no LLM call, so it only
// needs enough runway for the deterministic summary + downstream nodes
// (extractFindings/checkConfidence/validate/mitigation) to run, not a full
// aggregation LLM call.
const AGGREGATION_MIN_RUNWAY_MS_DEFAULT = 30_000;

export function getAggregationMinRunwayMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.AGGREGATION_MIN_RUNWAY_MS;
	if (raw == null || raw === "") return AGGREGATION_MIN_RUNWAY_MS_DEFAULT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 1) return AGGREGATION_MIN_RUNWAY_MS_DEFAULT;
	return Math.floor(parsed);
}

// Undefined deadline = no accounting (legacy/direct invocation) = always affordable.
export function hasAggregationBudget(
	deadlineAt: number | undefined,
	now: number = Date.now(),
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (deadlineAt === undefined) return true;
	return deadlineAt - now >= getAggregationMinRunwayMs(env);
}
