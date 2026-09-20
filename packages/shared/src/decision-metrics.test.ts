// shared/src/decision-metrics.test.ts
// SIO-1858. Real SQLite files under a temp dir, never a stubbed driver: the
// behaviour under test IS the disk interaction (WAL, strict binding, a write
// that must not throw), and a fake db would certify the assumption instead of
// the code.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDecisionMetricsRecorder,
	type DecisionMetricsLogger,
	rankCorrelation,
	resolveDecisionMetricsDbPath,
} from "./decision-metrics.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "decision-metrics-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface Row {
	at: string;
	seam: string;
	outcome: string;
	request_id: string | null;
	model: string | null;
	latency_ms: number | null;
	input_tokens: number | null;
	items_in: number | null;
	items_dropped: number | null;
	top_score: number | null;
	bottom_score: number | null;
	rank_correlation: number | null;
	note: string | null;
}

function readRows(dbPath: string): Row[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.query<Row, []>("SELECT * FROM decision_metrics ORDER BY at ASC").all();
	} finally {
		db.close(false);
	}
}

function collectingLogger(): { logger: DecisionMetricsLogger; messages: string[] } {
	const messages: string[] = [];
	return { logger: { warn: (message) => messages.push(message) }, messages };
}

describe("resolveDecisionMetricsDbPath", () => {
	test("returns the configured path", () => {
		expect(resolveDecisionMetricsDbPath({ DECISION_METRICS_DB_PATH: "/tmp/x.sqlite" })).toBe("/tmp/x.sqlite");
	});

	test("is undefined when unset or blank", () => {
		expect(resolveDecisionMetricsDbPath({})).toBeUndefined();
		expect(resolveDecisionMetricsDbPath({ DECISION_METRICS_DB_PATH: "   " })).toBeUndefined();
	});

	test("is undefined under NODE_ENV=test even with a path set", () => {
		// The guard that stops the suite writing into a developer's real DB.
		expect(
			resolveDecisionMetricsDbPath({ NODE_ENV: "test", DECISION_METRICS_DB_PATH: "/tmp/real.sqlite" }),
		).toBeUndefined();
	});
});

describe("rankCorrelation", () => {
	test("identical orderings are 1, reversed are -1", () => {
		expect(rankCorrelation([0, 1, 2, 3], [0, 1, 2, 3])).toBeCloseTo(1, 10);
		expect(rankCorrelation([0, 1, 2, 3], [3, 2, 1, 0])).toBeCloseTo(-1, 10);
	});

	test("one swapped adjacent pair sits just below 1", () => {
		const rho = rankCorrelation([0, 1, 2, 3], [1, 0, 2, 3]);
		expect(rho).toBeCloseTo(0.8, 10);
	});

	test("undefined rather than 0 when the coefficient is not answerable", () => {
		// 0 would read as "unrelated orderings", which is a different claim.
		expect(rankCorrelation([], [])).toBeUndefined();
		expect(rankCorrelation([1], [1])).toBeUndefined();
		expect(rankCorrelation([0, 1], [0])).toBeUndefined();
		expect(rankCorrelation([1, 1, 1], [0, 1, 2])).toBeUndefined();
	});

	test("handles ties without the no-ties shortcut formula", () => {
		// The 6*sum(d^2) shortcut is invalid with ties; tied model scores are
		// expected here, so the general form must be used.
		const rho = rankCorrelation([0, 1, 1, 3], [0, 1, 2, 3]);
		expect(rho).toBeDefined();
		expect(rho as number).toBeGreaterThan(0.9);
		expect(rho as number).toBeLessThan(1);
	});
});

describe("createDecisionMetricsRecorder", () => {
	test("writes one row per decision with every field round-tripped", async () => {
		const dbPath = join(dir, "m.sqlite");
		const recorder = await createDecisionMetricsRecorder({ dbPath, nowIso: () => "2026-09-20T10:00:00.000Z" });
		expect(recorder).toBeDefined();
		recorder?.record({
			seam: "atlassian-rerank",
			outcome: "applied",
			requestId: "req-1",
			model: "jev-1.13.0",
			latencyMs: 742,
			inputTokens: 3953,
			itemsIn: 10,
			itemsDropped: 4,
			topScore: 2.96,
			bottomScore: 0.01,
			rankCorrelation: 0.42,
			note: "ok",
		});
		recorder?.close();

		const rows = readRows(dbPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			at: "2026-09-20T10:00:00.000Z",
			seam: "atlassian-rerank",
			outcome: "applied",
			request_id: "req-1",
			model: "jev-1.13.0",
			latency_ms: 742,
			input_tokens: 3953,
			items_in: 10,
			items_dropped: 4,
			rank_correlation: 0.42,
			note: "ok",
		});
		expect(rows[0]?.top_score).toBeCloseTo(2.96, 6);
		expect(rows[0]?.bottom_score).toBeCloseTo(0.01, 6);
	});

	test("appends rows rather than upserting them (events, not counters)", async () => {
		// The distinction from mcp_tool_call_counts: the same seam twice is two
		// rows, which is what makes a time window answerable.
		const dbPath = join(dir, "m.sqlite");
		const recorder = await createDecisionMetricsRecorder({ dbPath });
		recorder?.record({ seam: "atlassian-rerank", outcome: "applied" });
		recorder?.record({ seam: "atlassian-rerank", outcome: "applied" });
		recorder?.record({ seam: "atlassian-rerank", outcome: "failed" });
		recorder?.close();

		const rows = readRows(dbPath);
		expect(rows).toHaveLength(3);
		expect(rows.filter((r) => r.outcome === "applied")).toHaveLength(2);
	});

	test("stores optional fields as NULL, not as a bound undefined", async () => {
		// Measured: bun:sqlite strict mode accepts undefined and stores NULL, so
		// this assertion holds with or without orNull under Bun. It is kept because
		// the node:sqlite fallback (SIO-1772) rejects undefined bindings, and both
		// drivers must produce identical rows.
		const dbPath = join(dir, "m.sqlite");
		const recorder = await createDecisionMetricsRecorder({ dbPath });
		recorder?.record({ seam: "monitor-gate", outcome: "skipped" });
		recorder?.close();

		const rows = readRows(dbPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.model).toBeNull();
		expect(rows[0]?.latency_ms).toBeNull();
		expect(rows[0]?.rank_correlation).toBeNull();
		expect(rows[0]?.note).toBeNull();
	});

	test("reopening an existing database keeps earlier rows", async () => {
		const dbPath = join(dir, "m.sqlite");
		const first = await createDecisionMetricsRecorder({ dbPath });
		first?.record({ seam: "atlassian-rerank", outcome: "applied" });
		first?.close();

		const second = await createDecisionMetricsRecorder({ dbPath });
		second?.record({ seam: "atlassian-rerank", outcome: "skipped" });
		second?.close();

		expect(readRows(dbPath)).toHaveLength(2);
	});

	test("returns undefined and warns when the database cannot be opened", async () => {
		// A directory where the file should be: open must fail, and the seam then
		// runs with no recorder rather than throwing.
		const { logger, messages } = collectingLogger();
		const recorder = await createDecisionMetricsRecorder({ dbPath: dir, logger });
		expect(recorder).toBeUndefined();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("cannot open database");
	});

	test("a write failure never throws and warns exactly once", async () => {
		const dbPath = join(dir, "m.sqlite");
		const { logger, messages } = collectingLogger();
		const recorder = await createDecisionMetricsRecorder({ dbPath, logger });
		expect(recorder).toBeDefined();
		// Drop the table underneath the prepared statement: the next writes fail
		// inside the recorder, which is the condition a turn must survive.
		const saboteur = new Database(dbPath);
		saboteur.run("DROP TABLE decision_metrics");
		saboteur.close(false);

		expect(() => recorder?.record({ seam: "atlassian-rerank", outcome: "applied" })).not.toThrow();
		expect(() => recorder?.record({ seam: "atlassian-rerank", outcome: "applied" })).not.toThrow();
		recorder?.close();

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("write failed");
	});

	test("record after close writes nothing, does not throw, and stays silent", async () => {
		// Three assertions because only the third pins the `closed` flag. bun:sqlite
		// throws "Database has closed" on a statement run after close (measured), and
		// the catch in record() would swallow that anyway -- so no-throw and no-row
		// hold with or without the flag. What the flag buys is silence: shutdown
		// ordering (a recorder closed before its last caller) must not be reported as
		// a write failure, or every clean shutdown logs a spurious warning.
		const dbPath = join(dir, "m.sqlite");
		const { logger, messages } = collectingLogger();
		const recorder = await createDecisionMetricsRecorder({ dbPath, logger });
		recorder?.record({ seam: "atlassian-rerank", outcome: "applied" });
		recorder?.close();
		expect(() => recorder?.record({ seam: "atlassian-rerank", outcome: "applied" })).not.toThrow();
		recorder?.close();

		expect(readRows(dbPath)).toHaveLength(1);
		expect(messages).toHaveLength(0);
	});
});
