// agent/src/graph-budget.test.ts
import { describe, expect, test } from "bun:test";
import {
	capSubAgentTimeoutMs,
	GRAPH_DEADLINE_KEY,
	getAggregationMinRunwayMs,
	getGraphBudgetMinRetryMs,
	getGraphBudgetReserveMs,
	getGraphDeadlineAt,
	hasAggregationBudget,
	hasRetryBudget,
} from "./graph-budget.ts";

// All assertions use explicit now/deadline values -- no wall-clock dependence.
const NOW = 1_752_000_000_000;
const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe("getGraphBudgetReserveMs", () => {
	test("returns 120_000 when env unset", () => {
		expect(getGraphBudgetReserveMs({})).toBe(120_000);
	});

	test("honors GRAPH_BUDGET_RESERVE_MS override", () => {
		expect(getGraphBudgetReserveMs({ GRAPH_BUDGET_RESERVE_MS: "90000" })).toBe(90_000);
	});

	test("falls back to default on invalid env values", () => {
		// "0.5" would floor to 0 and silently disable the reserve -- must reject.
		for (const raw of ["abc", "0", "-5", "0.5", ""]) {
			expect(getGraphBudgetReserveMs({ GRAPH_BUDGET_RESERVE_MS: raw })).toBe(120_000);
		}
	});

	test("floors fractional env values", () => {
		expect(getGraphBudgetReserveMs({ GRAPH_BUDGET_RESERVE_MS: "100500.7" })).toBe(100_500);
	});
});

describe("getGraphBudgetMinRetryMs", () => {
	test("returns 60_000 when env unset", () => {
		expect(getGraphBudgetMinRetryMs({})).toBe(60_000);
	});

	test("honors GRAPH_BUDGET_MIN_RETRY_MS override", () => {
		expect(getGraphBudgetMinRetryMs({ GRAPH_BUDGET_MIN_RETRY_MS: "30000" })).toBe(30_000);
	});

	test("falls back to default on invalid env values", () => {
		for (const raw of ["abc", "0", "-5", "0.5", ""]) {
			expect(getGraphBudgetMinRetryMs({ GRAPH_BUDGET_MIN_RETRY_MS: raw })).toBe(60_000);
		}
	});
});

describe("getGraphDeadlineAt", () => {
	test("returns undefined for missing config or key", () => {
		expect(getGraphDeadlineAt(undefined)).toBeUndefined();
		expect(getGraphDeadlineAt({})).toBeUndefined();
		expect(getGraphDeadlineAt({ configurable: {} })).toBeUndefined();
	});

	test("returns undefined for non-number or non-finite values", () => {
		expect(getGraphDeadlineAt({ configurable: { [GRAPH_DEADLINE_KEY]: "soon" } })).toBeUndefined();
		expect(getGraphDeadlineAt({ configurable: { [GRAPH_DEADLINE_KEY]: Number.NaN } })).toBeUndefined();
		expect(getGraphDeadlineAt({ configurable: { [GRAPH_DEADLINE_KEY]: Number.POSITIVE_INFINITY } })).toBeUndefined();
	});

	test("returns the threaded epoch-ms deadline", () => {
		expect(getGraphDeadlineAt({ configurable: { [GRAPH_DEADLINE_KEY]: NOW } })).toBe(NOW);
	});
});

describe("hasRetryBudget", () => {
	test("true when no deadline is threaded (legacy/direct invocation)", () => {
		expect(hasRetryBudget(undefined, NOW, EMPTY_ENV)).toBe(true);
	});

	test("boundary: remaining must cover reserve (120s) + min retry (60s)", () => {
		expect(hasRetryBudget(NOW + 179_999, NOW, EMPTY_ENV)).toBe(false);
		expect(hasRetryBudget(NOW + 180_000, NOW, EMPTY_ENV)).toBe(true);
	});

	test("false when the deadline already passed", () => {
		expect(hasRetryBudget(NOW - 1, NOW, EMPTY_ENV)).toBe(false);
	});

	test("env-shrunk reserve flips the verdict", () => {
		const env = { GRAPH_BUDGET_RESERVE_MS: "10000", GRAPH_BUDGET_MIN_RETRY_MS: "10000" };
		expect(hasRetryBudget(NOW + 20_000, NOW, env)).toBe(true);
		expect(hasRetryBudget(NOW + 19_999, NOW, env)).toBe(false);
	});
});

describe("capSubAgentTimeoutMs", () => {
	test("returns base when no deadline is threaded", () => {
		expect(capSubAgentTimeoutMs(360_000, undefined, NOW, EMPTY_ENV)).toBe(360_000);
	});

	test("returns base when budget is ample", () => {
		expect(capSubAgentTimeoutMs(360_000, NOW + 900_000, NOW, EMPTY_ENV)).toBe(360_000);
	});

	test("caps at remaining minus reserve when budget is tight", () => {
		// remaining 300s - reserve 120s = 180s cap
		expect(capSubAgentTimeoutMs(360_000, NOW + 300_000, NOW, EMPTY_ENV)).toBe(180_000);
	});

	test("floors at 1s when the budget is exhausted", () => {
		expect(capSubAgentTimeoutMs(360_000, NOW + 100_000, NOW, EMPTY_ENV)).toBe(1_000);
		expect(capSubAgentTimeoutMs(360_000, NOW - 100_000, NOW, EMPTY_ENV)).toBe(1_000);
	});
});

describe("getAggregationMinRunwayMs", () => {
	test("returns 30_000 when env unset", () => {
		expect(getAggregationMinRunwayMs({})).toBe(30_000);
	});

	test("honors AGGREGATION_MIN_RUNWAY_MS override", () => {
		expect(getAggregationMinRunwayMs({ AGGREGATION_MIN_RUNWAY_MS: "45000" })).toBe(45_000);
	});

	test("falls back to default on invalid env values", () => {
		for (const raw of ["abc", "0", "-5", "0.5", ""]) {
			expect(getAggregationMinRunwayMs({ AGGREGATION_MIN_RUNWAY_MS: raw })).toBe(30_000);
		}
	});
});

// SIO-1221: real-trace regression. A run where GitLab's alignment retry burned
// its full 360s on top of the first attempt's 360s left only ~158s before the
// graph-wide deadline -- aggregate() still attempted a full LLM call and was
// hard-aborted mid-generation (needed 159s+, had no completion at all). This
// verifies the budget check would have correctly identified "proceed" here
// (158s > 30s runway floor -- the LLM call itself was the risk, not the
// deterministic fallback path) and "skip" once the deadline is imminent.
describe("hasAggregationBudget", () => {
	test("true when no deadline is threaded (legacy/direct invocation)", () => {
		expect(hasAggregationBudget(undefined, NOW, EMPTY_ENV)).toBe(true);
	});

	test("boundary: remaining must cover the 30s runway floor", () => {
		expect(hasAggregationBudget(NOW + 29_999, NOW, EMPTY_ENV)).toBe(false);
		expect(hasAggregationBudget(NOW + 30_000, NOW, EMPTY_ENV)).toBe(true);
	});

	test("false when the deadline already passed", () => {
		expect(hasAggregationBudget(NOW - 1, NOW, EMPTY_ENV)).toBe(false);
	});

	test("env-shrunk runway floor flips the verdict", () => {
		const env = { AGGREGATION_MIN_RUNWAY_MS: "10000" };
		expect(hasAggregationBudget(NOW + 10_000, NOW, env)).toBe(true);
		expect(hasAggregationBudget(NOW + 9_999, NOW, env)).toBe(false);
	});
});
