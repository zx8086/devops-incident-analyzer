// agent/src/app-map-baseline.test.ts
import { describe, expect, test } from "bun:test";
import {
	appMapBaselineLookback,
	appMapBaselineTimeoutMs,
	destinationAggregationArgs,
	fetchAppMapBaseline,
	isAppMapBaselineEnabled,
} from "./app-map-baseline.ts";

describe("env tunables", () => {
	test("enabled by default; only explicit false/0 disables", () => {
		expect(isAppMapBaselineEnabled({} as NodeJS.ProcessEnv)).toBe(true);
		expect(isAppMapBaselineEnabled({ APP_MAP_BASELINE_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isAppMapBaselineEnabled({ APP_MAP_BASELINE_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
		expect(isAppMapBaselineEnabled({ APP_MAP_BASELINE_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
	});

	// readPositiveIntEnv reads process.env directly; save/restore around each case.
	test("timeout defaults to 8000 and rejects junk", () => {
		const prev = process.env.APP_MAP_BASELINE_TIMEOUT_MS;
		try {
			delete process.env.APP_MAP_BASELINE_TIMEOUT_MS;
			expect(appMapBaselineTimeoutMs()).toBe(8000);
			process.env.APP_MAP_BASELINE_TIMEOUT_MS = "2500";
			expect(appMapBaselineTimeoutMs()).toBe(2500);
			process.env.APP_MAP_BASELINE_TIMEOUT_MS = "-5";
			expect(appMapBaselineTimeoutMs()).toBe(8000);
			process.env.APP_MAP_BASELINE_TIMEOUT_MS = "soon";
			expect(appMapBaselineTimeoutMs()).toBe(8000);
			// The setTimeout max-delay clamp survives the helper migration.
			process.env.APP_MAP_BASELINE_TIMEOUT_MS = "9999999999";
			expect(appMapBaselineTimeoutMs()).toBe(2_147_483_647);
		} finally {
			if (prev === undefined) delete process.env.APP_MAP_BASELINE_TIMEOUT_MS;
			else process.env.APP_MAP_BASELINE_TIMEOUT_MS = prev;
		}
	});

	test("lookback defaults to now-1h and rejects non-relative windows", () => {
		expect(appMapBaselineLookback({} as NodeJS.ProcessEnv)).toBe("now-1h");
		expect(appMapBaselineLookback({ APP_MAP_BASELINE_LOOKBACK: "now-30m" } as NodeJS.ProcessEnv)).toBe("now-30m");
		expect(appMapBaselineLookback({ APP_MAP_BASELINE_LOOKBACK: "2026-01-01" } as NodeJS.ProcessEnv)).toBe("now-1h");
	});
});

describe("destinationAggregationArgs", () => {
	test("aggregation-only exit-span query with nested destination terms", () => {
		const args = destinationAggregationArgs("now-1h");
		expect(args.index).toBe("traces-apm*");
		expect(args.size).toBe(0);
		const query = args.query as { bool: { filter: unknown[] } };
		expect(query.bool.filter).toContainEqual({ exists: { field: "span.destination.service.resource" } });
		expect(query.bool.filter).toContainEqual({ range: { "@timestamp": { gte: "now-1h" } } });
		const aggs = args.aggs as {
			by_source: { terms: { field: string }; aggs: { by_destination: { terms: { field: string } } } };
		};
		expect(aggs.by_source.terms.field).toBe("service.name");
		expect(aggs.by_source.aggs.by_destination.terms.field).toBe("span.destination.service.resource");
	});
});

describe("fetchAppMapBaseline", () => {
	test("skips when elasticsearch_search is not on the belt", async () => {
		const r = await fetchAppMapBaseline({
			invoke: async () => ({}),
			hasTool: () => false,
		});
		expect(r.outputs).toEqual([]);
		expect(r.diagnostics.skippedReason).toBe("no-search-tool");
	});

	test("soft-fails when invoke throws", async () => {
		const r = await fetchAppMapBaseline({
			invoke: async () => {
				throw new Error("boom");
			},
			hasTool: () => true,
		});
		expect(r.outputs).toEqual([]);
		expect(r.diagnostics.skippedReason).toBe("invoke-failed");
	});

	test("soft-fails on the deadline without rejecting", async () => {
		const r = await fetchAppMapBaseline({
			invoke: () => new Promise(() => {}),
			hasTool: () => true,
			timeoutMs: 20,
		});
		expect(r.outputs).toEqual([]);
		expect(r.diagnostics.skippedReason).toBe("timed-out");
	});

	test("records the aggregation output under the real tool name", async () => {
		let seenTool = "";
		let seenArgs: Record<string, unknown> = {};
		const payload = { aggregations: { by_source: { buckets: [] } } };
		const r = await fetchAppMapBaseline({
			invoke: async (toolName, args) => {
				seenTool = toolName;
				seenArgs = args;
				return payload;
			},
			hasTool: (n) => n === "elasticsearch_search",
			lookback: "now-2h",
		});
		expect(seenTool).toBe("elasticsearch_search");
		expect((seenArgs.query as { bool: { filter: unknown[] } }).bool.filter).toContainEqual({
			range: { "@timestamp": { gte: "now-2h" } },
		});
		expect(r.outputs).toEqual([{ toolName: "elasticsearch_search", rawJson: payload }]);
		expect(r.diagnostics.skippedReason).toBeUndefined();
	});
});
