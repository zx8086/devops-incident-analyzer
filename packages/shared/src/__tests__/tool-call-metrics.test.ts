// shared/src/__tests__/tool-call-metrics.test.ts

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createToolCallMetricsRecorder,
	resolveToolCallMetricsDbPath,
	type ToolCallMetricsRecorder,
} from "../tool-call-metrics.ts";

interface CountRow {
	server: string;
	tool: string;
	calls: number;
	failures: number;
	first_called_at: string;
	last_called_at: string;
}

function readRows(dbPath: string): CountRow[] {
	const db = new Database(dbPath, { readonly: true });
	const rows = db
		.query<CountRow, []>(
			"SELECT server, tool, calls, failures, first_called_at, last_called_at FROM mcp_tool_call_counts ORDER BY server, tool",
		)
		.all();
	db.close(false);
	return rows;
}

function warnRecorder() {
	const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
	return {
		warnings,
		logger: { warn: (message: string, meta?: Record<string, unknown>) => warnings.push({ message, meta }) },
	};
}

describe("resolveToolCallMetricsDbPath", () => {
	test("returns the trimmed path when set, undefined when unset or blank", () => {
		expect(resolveToolCallMetricsDbPath({ MCP_TOOL_METRICS_DB_PATH: " /tmp/x.sqlite " })).toBe("/tmp/x.sqlite");
		expect(resolveToolCallMetricsDbPath({})).toBeUndefined();
		expect(resolveToolCallMetricsDbPath({ MCP_TOOL_METRICS_DB_PATH: "" })).toBeUndefined();
		expect(resolveToolCallMetricsDbPath({ MCP_TOOL_METRICS_DB_PATH: "   " })).toBeUndefined();
	});

	test("stays off under NODE_ENV=test so test traffic never pollutes the real counters", () => {
		expect(
			resolveToolCallMetricsDbPath({ NODE_ENV: "test", MCP_TOOL_METRICS_DB_PATH: "/tmp/x.sqlite" }),
		).toBeUndefined();
		// this very test run proves the guard is live
		expect(resolveToolCallMetricsDbPath()).toBeUndefined();
	});
});

describe("createToolCallMetricsRecorder", () => {
	let dir: string;
	let dbPath: string;
	const openRecorders: ToolCallMetricsRecorder[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tool-call-metrics-"));
		dbPath = join(dir, "nested", "metrics.sqlite");
	});

	afterEach(() => {
		for (const recorder of openRecorders.splice(0)) recorder.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function openRecorder(serverName: string, nowIso?: () => string): Promise<ToolCallMetricsRecorder> {
		const recorder = await createToolCallMetricsRecorder({ serverName, dbPath, nowIso });
		if (!recorder) throw new Error("expected recorder to open");
		openRecorders.push(recorder);
		return recorder;
	}

	test("accumulates calls and failures per tool; first stays, last advances", async () => {
		const ticks = ["2026-08-06T10:00:00.000Z", "2026-08-06T10:00:01.000Z", "2026-08-06T10:00:02.000Z"];
		let i = 0;
		const recorder = await openRecorder("elastic-mcp-server", () => ticks[Math.min(i++, ticks.length - 1)] as string);

		recorder.record("search", true);
		recorder.record("search", true);
		recorder.record("search", false);
		recorder.close();

		const rows = readRows(dbPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			server: "elastic-mcp-server",
			tool: "search",
			calls: 3,
			failures: 1,
			first_called_at: "2026-08-06T10:00:00.000Z",
			last_called_at: "2026-08-06T10:00:02.000Z",
		});
	});

	test("separate rows per server and per tool (multi-process shape)", async () => {
		const a = await openRecorder("elastic-mcp-server");
		const b = await openRecorder("kafka-mcp-server");
		a.record("search", true);
		a.record("get_mappings", false);
		b.record("search", true);
		a.close();
		b.close();

		const rows = readRows(dbPath);
		expect(rows.map((r) => `${r.server}/${r.tool}`)).toEqual([
			"elastic-mcp-server/get_mappings",
			"elastic-mcp-server/search",
			"kafka-mcp-server/search",
		]);
	});

	test("reopening the same path accumulates onto existing rows", async () => {
		const first = await openRecorder("elastic-mcp-server");
		first.record("search", true);
		first.close();

		const second = await openRecorder("elastic-mcp-server");
		second.record("search", false);
		second.close();

		const rows = readRows(dbPath);
		expect(rows[0]?.calls).toBe(2);
		expect(rows[0]?.failures).toBe(1);
	});

	test("soft-fails to undefined (with a warning) when the path is unusable", async () => {
		const { warnings, logger } = warnRecorder();
		// dir itself exists as a directory -- opening it as a DB file must fail
		const recorder = await createToolCallMetricsRecorder({ serverName: "x", dbPath: dir, logger });
		expect(recorder).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("metrics disabled");
	});

	test("record() after close() is a no-op and never throws", async () => {
		const recorder = await openRecorder("elastic-mcp-server");
		recorder.record("search", true);
		recorder.close();
		expect(() => recorder.record("search", true)).not.toThrow();
		expect(() => recorder.close()).not.toThrow();
		expect(readRows(dbPath)[0]?.calls).toBe(1);
	});
});
