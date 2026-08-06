// shared/src/__tests__/tool-call-metrics.test.ts

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyFailureText,
	createToolCallMetricsRecorder,
	resolveToolCallMetricsDbPath,
	type ToolCallMetricsRecorder,
} from "../tool-call-metrics.ts";
import { buildToolErrorEnvelope } from "../tool-error.ts";

interface CountRow {
	server: string;
	tool: string;
	calls: number;
	failures: number;
	bad_input_failures: number;
	unstructured_failures: number;
	unknown_tool_failures: number;
	first_called_at: string;
	last_called_at: string;
}

function readRows(dbPath: string): CountRow[] {
	const db = new Database(dbPath, { readonly: true });
	const rows = db
		.query<CountRow, []>(
			"SELECT server, tool, calls, failures, bad_input_failures, unstructured_failures, unknown_tool_failures, first_called_at, last_called_at FROM mcp_tool_call_counts ORDER BY server, tool",
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

// SIO-1402: same rule as the eval toolset's tool_arg_validity -- bad-input when
// category is "bad-query" OR kind is "bad-input"; unstructured when no { _error }
// envelope parses out of the text.
describe("classifyFailureText", () => {
	test("bad-query envelope classifies bad-input", () => {
		const text = JSON.stringify(buildToolErrorEnvelope({ kind: "bad-query", message: "malformed DSL" }));
		expect(classifyFailureText(text)).toBe("bad-input");
	});

	test("bad-input kind classifies bad-input even though its category maps to unknown", () => {
		const text = JSON.stringify(buildToolErrorEnvelope({ kind: "bad-input", message: "param out of range" }));
		expect(classifyFailureText(text)).toBe("bad-input");
	});

	test("envelope behind an MCP error prefix still parses (brace scan, not whole-string)", () => {
		const envelope = JSON.stringify(buildToolErrorEnvelope({ kind: "bad-query", message: "bad window" }));
		expect(classifyFailureText(`MCP error -32602: ${envelope}`)).toBe("bad-input");
	});

	test("other structured kinds classify structured-other", () => {
		const text = JSON.stringify(buildToolErrorEnvelope({ kind: "not-found", message: "index missing" }));
		expect(classifyFailureText(text)).toBe("structured-other");
		const throttled = JSON.stringify(buildToolErrorEnvelope({ kind: "throttled", message: "429", statusCode: 429 }));
		expect(classifyFailureText(throttled)).toBe("structured-other");
	});

	test("prose, JSON without _error, unknown kinds, and empty text classify unstructured", () => {
		expect(classifyFailureText("Index not found: logs-x")).toBe("unstructured");
		expect(classifyFailureText('{"error":"nope"}')).toBe("unstructured");
		expect(classifyFailureText('{"_error":{"kind":"made-up-kind","message":"x"}}')).toBe("unstructured");
		expect(classifyFailureText("")).toBe("unstructured");
		expect(classifyFailureText(undefined)).toBe("unstructured");
	});

	// SIO-1402 (CodeRabbit): enum schemas gate the envelope fields, so inherited
	// property names never leak through an `in` check as structured-other.
	test("inherited property names as kind/category classify unstructured", () => {
		for (const name of ["toString", "constructor", "__proto__"]) {
			expect(classifyFailureText(`{"_error":{"kind":"${name}","message":"x"}}`)).toBe("unstructured");
			expect(classifyFailureText(`{"_error":{"kind":"bad-query","category":"${name}","message":"x"}}`)).toBe(
				// invalid category on a valid kind falls back to the kind's mapping
				"bad-input",
			);
		}
		// a category value that is a KIND but not a CATEGORY must not pass either
		expect(classifyFailureText('{"_error":{"kind":"not-found","category":"throttled","message":"x"}}')).toBe(
			"structured-other",
		);
	});

	// SIO-1407: argument-validation rejections are the canonical bad-input event.
	// Both fixtures are live-captured (elastic missing-LIMIT custom rule, couchbase
	// missing scope_name) -- prose + raw zod issues, no envelope.
	test("argument-validation rejection text classifies bad-input", () => {
		expect(
			classifyFailureText(
				'MCP error -32602: Input validation error: Invalid arguments for tool elasticsearch_esql_query: [\n  {\n    "code": "custom",\n    "path": ["query"],\n    "message": "ES|QL query must include a `| LIMIT <n>` clause."\n  }\n]',
			),
		).toBe("bad-input");
		expect(
			classifyFailureText(
				'MCP error -32602: Input validation error: Invalid arguments for tool capella_run_sql_plus_plus_query: [\n  {\n    "expected": "string",\n    "code": "invalid_type",\n    "path": ["scope_name"],\n    "message": "Invalid input: expected string, received undefined"\n  }\n]',
			),
		).toBe("bad-input");
		// both prefixes are optional across SDK versions
		expect(classifyFailureText("Invalid arguments for tool kafka_list_topics: [bad]")).toBe("bad-input");
		// "toolsmith" must not match the "tool <name>" form
		expect(classifyFailureText("Invalid arguments for toolsmith")).toBe("unstructured");
	});

	// SIO-1402: the SDK RESOLVES an unknown tool name into this exact error text
	// (measured; it does not reject at dispatch).
	test("the SDK's unknown-tool text classifies unknown-tool", () => {
		expect(classifyFailureText("MCP error -32602: Tool no_such_tool not found")).toBe("unknown-tool");
		expect(classifyFailureText("Tool kafka_list_topicz not found")).toBe("unknown-tool");
		// resource-not-found prose is NOT a tool-name miss
		expect(classifyFailureText("Index logs-x not found")).toBe("unstructured");
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
			bad_input_failures: 0,
			unstructured_failures: 0,
			unknown_tool_failures: 0,
			first_called_at: "2026-08-06T10:00:00.000Z",
			last_called_at: "2026-08-06T10:00:02.000Z",
		});
	});

	// SIO-1402: each failure class increments exactly its own column plus failures.
	test("failure classes increment their columns", async () => {
		const recorder = await openRecorder("elastic-mcp-server");
		recorder.record("search", true);
		recorder.record("search", false, "bad-input");
		recorder.record("search", false, "unstructured");
		recorder.record("search", false, "unknown-tool");
		recorder.record("search", false, "structured-other");
		recorder.record("search", false);
		recorder.close();

		const row = readRows(dbPath)[0];
		expect(row?.calls).toBe(6);
		expect(row?.failures).toBe(5);
		expect(row?.bad_input_failures).toBe(1);
		expect(row?.unstructured_failures).toBe(1);
		expect(row?.unknown_tool_failures).toBe(1);
	});

	// SIO-1402: CREATE TABLE IF NOT EXISTS cannot add columns, so a pre-1402 DB is
	// ALTERed in place; existing rows keep their counts with zeroed classes.
	test("migrates a pre-1402 database in place and accumulates onto legacy rows", async () => {
		mkdirSync(join(dir, "nested"), { recursive: true });
		const legacy = new Database(dbPath, { create: true, strict: true });
		legacy.run(
			"CREATE TABLE mcp_tool_call_counts (server TEXT NOT NULL, tool TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, first_called_at TEXT NOT NULL, last_called_at TEXT NOT NULL, PRIMARY KEY (server, tool))",
		);
		legacy.run(
			"INSERT INTO mcp_tool_call_counts (server, tool, calls, failures, first_called_at, last_called_at) VALUES ('elastic-mcp-server', 'search', 5, 2, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z')",
		);
		legacy.close(false);

		const recorder = await openRecorder("elastic-mcp-server");
		recorder.record("search", false, "bad-input");
		recorder.close();

		const row = readRows(dbPath)[0];
		expect(row?.calls).toBe(6);
		expect(row?.failures).toBe(3);
		expect(row?.bad_input_failures).toBe(1);
		expect(row?.unstructured_failures).toBe(0);
		expect(row?.first_called_at).toBe("2026-08-01T00:00:00.000Z");
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
