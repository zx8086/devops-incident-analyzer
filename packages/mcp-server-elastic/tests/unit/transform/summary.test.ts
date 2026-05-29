// tests/unit/transform/summary.test.ts
// SIO-831: Tests for the shared summary projection helpers
// (summary.ts) — parseEsDuration, summarizeTransform, summarizeTransformStats.

import { describe, expect, test } from "bun:test";
import {
	parseEsDuration,
	renderStatsSummaryLine,
	renderSummaryLine,
	summarizeTransform,
	summarizeTransformStats,
} from "../../../src/tools/transform/summary.js";

describe("parseEsDuration", () => {
	test("parses seconds, minutes, hours, days, ms", () => {
		expect(parseEsDuration("100ms")).toBe(100);
		expect(parseEsDuration("30s")).toBe(30_000);
		expect(parseEsDuration("5m")).toBe(5 * 60_000);
		expect(parseEsDuration("24h")).toBe(24 * 60 * 60_000);
		expect(parseEsDuration("7d")).toBe(7 * 24 * 60 * 60_000);
	});

	test("trims whitespace", () => {
		expect(parseEsDuration("  24h  ")).toBe(24 * 60 * 60_000);
	});

	test("rejects invalid forms", () => {
		expect(parseEsDuration("h24")).toBeNull();
		expect(parseEsDuration("24")).toBeNull();
		expect(parseEsDuration("")).toBeNull();
		expect(parseEsDuration("forever")).toBeNull();
		expect(parseEsDuration("1y")).toBeNull(); // ES rejects "year" units
	});
});

describe("summarizeTransform", () => {
	const fullTransform = {
		id: "mulesoft-aggs-v8",
		source: { index: ["traces-apm-*", "logs-apm-*"], query: { match_all: {} } },
		dest: { index: "mulesoft-aggs-v8-dest", pipeline: "tag-aggs" },
		pivot: { group_by: {}, aggregations: {} },
		sync: { time: { field: "@timestamp", delay: "60s" } },
		retention_policy: { time: { field: "@timestamp", max_age: "30d" } },
		frequency: "1m",
		description: "Mulesoft v8 aggregations",
	};

	test("projects all expected fields", () => {
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		const s = summarizeTransform(fullTransform as any);
		expect(s.id).toBe("mulesoft-aggs-v8");
		expect(s.mode).toBe("pivot");
		expect(s.source_index).toBe("traces-apm-*,logs-apm-*");
		expect(s.dest_index).toBe("mulesoft-aggs-v8-dest");
		expect(s.dest_pipeline).toBe("tag-aggs");
		expect(s.sync_field).toBe("@timestamp");
		expect(s.retention_max_age).toBe("30d");
		expect(s.frequency).toBe("1m");
		expect(s.description).toBe("Mulesoft v8 aggregations");
	});

	test("handles a latest transform (no pivot)", () => {
		const latest = {
			id: "users-latest",
			source: { index: "users-*" },
			dest: { index: "users-latest-dest" },
			latest: { unique_key: ["user_id"], sort: "@timestamp" },
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		expect(summarizeTransform(latest as any).mode).toBe("latest");
	});

	test("renderSummaryLine includes only present optional fields", () => {
		const minimal = {
			id: "minimal",
			source: { index: "src" },
			dest: { index: "dst" },
			pivot: { group_by: {}, aggregations: {} },
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - minimal-shape fixture; SDK type would require full TransformSummary shape
		const line = renderSummaryLine(summarizeTransform(minimal as any));
		expect(line).toBe("- `minimal` (pivot) src=src dest=dst");
	});
});

describe("summarizeTransformStats", () => {
	const FIXED_NOW = new Date("2026-05-29T12:00:00Z").getTime();
	const ONE_HOUR_AGO = FIXED_NOW - 60 * 60_000;
	const TWO_DAYS_AGO = FIXED_NOW - 2 * 24 * 60 * 60_000;

	const baseStats = {
		id: "t1",
		state: "started",
		checkpointing: {
			last: { checkpoint: 42, timestamp_millis: ONE_HOUR_AGO },
		},
		stats: { trigger_count: 100, index_failures: 3, search_failures: 1 },
		health: { status: "green" },
		node: { id: "node-a", name: "node-a-name" },
	};

	test("derives last_checkpoint_age_seconds, failure_rate, is_stalled (not stalled)", () => {
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		const s = summarizeTransformStats(baseStats as any, { nowMs: FIXED_NOW });
		expect(s.id).toBe("t1");
		expect(s.last_checkpoint).toBe(42);
		expect(s.last_checkpoint_age_seconds).toBe(3600);
		expect(s.failure_rate).toBe(0.04);
		expect(s.is_stalled).toBe(false);
		expect(s.node).toBe("node-a-name");
	});

	test("is_stalled true when last checkpoint older than stalledAfter", () => {
		const stalled = {
			...baseStats,
			checkpointing: { last: { checkpoint: 1, timestamp_millis: TWO_DAYS_AGO } },
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		const s = summarizeTransformStats(stalled as any, { nowMs: FIXED_NOW });
		expect(s.is_stalled).toBe(true);
		expect(s.last_checkpoint_age_seconds).toBe(2 * 24 * 60 * 60);
	});

	test("custom stalledAfterMs (1h) catches a 90m-old checkpoint", () => {
		const ninetyMinAgo = FIXED_NOW - 90 * 60_000;
		const fixture = { ...baseStats, checkpointing: { last: { checkpoint: 5, timestamp_millis: ninetyMinAgo } } };
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		const s = summarizeTransformStats(fixture as any, { nowMs: FIXED_NOW, stalledAfterMs: 60 * 60_000 });
		expect(s.is_stalled).toBe(true);
	});

	test("failure_rate is 0 when trigger_count is 0 (no divide-by-zero)", () => {
		const fresh = {
			...baseStats,
			stats: { trigger_count: 0, index_failures: 0, search_failures: 0 },
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		const s = summarizeTransformStats(fresh as any, { nowMs: FIXED_NOW });
		expect(s.failure_rate).toBe(0);
	});

	test("missing checkpointing yields nulls and is_stalled=false", () => {
		const noCheckpoint = { id: "t1", state: "stopped" };
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		const s = summarizeTransformStats(noCheckpoint as any, { nowMs: FIXED_NOW });
		expect(s.last_checkpoint).toBeNull();
		expect(s.last_checkpoint_age_seconds).toBeNull();
		expect(s.is_stalled).toBe(false);
	});

	test("node falls back to id when name is missing, then n/a", () => {
		const noName = { ...baseStats, node: { id: "node-x" } };
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		expect(summarizeTransformStats(noName as any, { nowMs: FIXED_NOW }).node).toBe("node-x");
		const noNode = { ...baseStats, node: undefined };
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		expect(summarizeTransformStats(noNode as any, { nowMs: FIXED_NOW }).node).toBe("n/a");
	});

	test("renderStatsSummaryLine includes STALLED suffix when applicable", () => {
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		const s = summarizeTransformStats(baseStats as any, { nowMs: FIXED_NOW });
		expect(renderStatsSummaryLine(s)).not.toContain("STALLED");

		const stalled = { ...baseStats, checkpointing: { last: { timestamp_millis: TWO_DAYS_AGO } } };
		// biome-ignore lint/suspicious/noExplicitAny: SIO-831 - test fixture predates the typed estypes SDK shape; use any to avoid a fragile re-typing
		expect(renderStatsSummaryLine(summarizeTransformStats(stalled as any, { nowMs: FIXED_NOW }))).toContain("STALLED");
	});
});
