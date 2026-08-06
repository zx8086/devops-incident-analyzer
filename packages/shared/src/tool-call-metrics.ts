// shared/src/tool-call-metrics.ts
// SIO-1400: opt-in per-server/per-tool call counters in a local SQLite file so
// under-used or error-prone MCP tools are visible. One row per (server, tool)
// with lifetime calls/failures. Enabled only when MCP_TOOL_METRICS_DB_PATH is
// set; several MCP server processes append to the same file (WAL + busy_timeout).
// Load-bearing rule: metrics must NEVER break a tool call -- every operation
// soft-fails, and a failed open disables the feature for the process.
// SIO-1402: failure-class breakdown reusing the eval toolset's deterministic
// criteria signals (tool_arg_validity / prose-only-error / tool_name_validity)
// and the shared ToolErrorKind/ToolErrorCategory vocabulary from agent-state.ts.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TOOL_ERROR_KIND_TO_CATEGORY, type ToolErrorCategory, type ToolErrorKind } from "./agent-state.ts";

export interface ToolCallMetricsLogger {
	warn(message: string, meta?: Record<string, unknown>): void;
}

// SIO-1402: closed per-failure classification, all derived from the error result
// text by classifyFailureText: "unknown-tool" (the SDK's resolved tool-name-miss
// form), "bad-input", "unstructured", and "structured-other" (a well-formed
// envelope of any other kind; counted only in the plain failures column).
export type ToolCallFailureClass = "bad-input" | "unstructured" | "unknown-tool" | "structured-other";

export interface ToolCallMetricsRecorder {
	record(tool: string, ok: boolean, failureClass?: ToolCallFailureClass): void;
	close(): void;
}

export function resolveToolCallMetricsDbPath(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	// bun test sets NODE_ENV=test and auto-loads .env, so without this guard every
	// test that boots a server or proxy would upsert fake traffic into the real
	// counters DB the developer configured in .env.
	if (env.NODE_ENV === "test") return undefined;
	const raw = env.MCP_TOOL_METRICS_DB_PATH?.trim();
	return raw ? raw : undefined;
}

// SIO-1402: classify an error result's text content against the shared envelope
// vocabulary. The wire shape is JSON.stringify({ _error: { kind, category, ... } }),
// sometimes behind an "MCP error NNN: " prefix on thrown paths -- so brace-scan
// (first "{" to last "}") instead of whole-string parsing. Pure string function:
// no bun: imports, safe in the Vite-SSR bundle, and cheap because callers only
// invoke it on isError results.
// - "unknown-tool": the SDK's normalised unknown-tool-name result. Measured
//   behavior (not the docs' obvious guess): the tools/call dispatch does NOT
//   reject an unknown name -- it RESOLVES { isError: true, content: [{ text:
//   "MCP error -32602: Tool <name> not found" }] }, so the name-hallucination
//   signal arrives as error text, matched here before the envelope scan.
// - "bad-input": category "bad-query" OR kind "bad-input" (same rule as the eval
//   toolset's tool_arg_validity) -- the model passed bad arguments.
// - "unstructured": no parseable { _error } envelope -- the failure bypassed
//   buildToolErrorEnvelope and will classify agent-side as unknown (degrading).
// - "structured-other": a well-formed envelope of any other kind.
const UNKNOWN_TOOL_TEXT_RE = /^(?:MCP error -\d+: )?Tool \S+ not found$/;

export function classifyFailureText(text: string | undefined): ToolCallFailureClass {
	if (!text) return "unstructured";
	if (UNKNOWN_TOOL_TEXT_RE.test(text.trim())) return "unknown-tool";
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return "unstructured";
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return "unstructured";
	}
	if (typeof parsed !== "object" || parsed === null) return "unstructured";
	const err = (parsed as { _error?: unknown })._error;
	if (typeof err !== "object" || err === null) return "unstructured";
	const kind = (err as { kind?: unknown }).kind;
	if (typeof kind !== "string" || !(kind in TOOL_ERROR_KIND_TO_CATEGORY)) return "unstructured";
	const rawCategory = (err as { category?: unknown }).category;
	const category: ToolErrorCategory =
		typeof rawCategory === "string" && rawCategory in TOOL_ERROR_KIND_TO_CATEGORY
			? (rawCategory as ToolErrorCategory)
			: TOOL_ERROR_KIND_TO_CATEGORY[kind as ToolErrorKind];
	if (category === "bad-query" || kind === "bad-input") return "bad-input";
	return "structured-other";
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mcp_tool_call_counts (
	server TEXT NOT NULL,
	tool TEXT NOT NULL,
	calls INTEGER NOT NULL DEFAULT 0,
	failures INTEGER NOT NULL DEFAULT 0,
	bad_input_failures INTEGER NOT NULL DEFAULT 0,
	unstructured_failures INTEGER NOT NULL DEFAULT 0,
	unknown_tool_failures INTEGER NOT NULL DEFAULT 0,
	first_called_at TEXT NOT NULL,
	last_called_at TEXT NOT NULL,
	PRIMARY KEY (server, tool)
)`;

// SIO-1402: CREATE TABLE IF NOT EXISTS does not add columns to a pre-existing
// SIO-1400 DB, so newly introduced counter columns are ALTERed in when missing.
const MIGRATED_COLUMNS = ["bad_input_failures", "unstructured_failures", "unknown_tool_failures"] as const;

const UPSERT_SQL = `
INSERT INTO mcp_tool_call_counts (
	server, tool, calls, failures,
	bad_input_failures, unstructured_failures, unknown_tool_failures,
	first_called_at, last_called_at
)
VALUES ($server, $tool, 1, $failed, $badInput, $unstructured, $unknownTool, $now, $now)
ON CONFLICT (server, tool) DO UPDATE SET
	calls = calls + 1,
	failures = failures + excluded.failures,
	bad_input_failures = bad_input_failures + excluded.bad_input_failures,
	unstructured_failures = unstructured_failures + excluded.unstructured_failures,
	unknown_tool_failures = unknown_tool_failures + excluded.unknown_tool_failures,
	last_called_at = excluded.last_called_at`;

export async function createToolCallMetricsRecorder(options: {
	serverName: string;
	dbPath: string;
	logger?: ToolCallMetricsLogger;
	nowIso?: () => string;
}): Promise<ToolCallMetricsRecorder | undefined> {
	const { serverName, dbPath, logger } = options;
	const nowIso = options.nowIso ?? (() => new Date().toISOString());
	try {
		// bun:sqlite is imported lazily: the shared package is bundled as source into
		// the web app's Vite SSR build (ssr.noExternal), where a top-level "bun:"
		// specifier is unresolvable. @vite-ignore keeps Vite from touching it; at
		// runtime every consumer of this factory runs under Bun, where it resolves.
		const { Database } = await import(/* @vite-ignore */ "bun:sqlite");
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = new Database(dbPath, { create: true, strict: true });
		// busy_timeout BEFORE journal_mode: switching to WAL takes a lock, and with
		// no busy handler a concurrent opener (8+ servers cold-starting on one DB)
		// fails instantly with "database is locked" -- measured 11/40 in a race
		// harness; 0/40 with this order.
		db.run("PRAGMA busy_timeout = 5000;");
		db.run("PRAGMA journal_mode = WAL;");
		db.run(CREATE_TABLE_SQL);
		const existing = new Set(
			db
				.query<{ name: string }, []>("PRAGMA table_info(mcp_tool_call_counts)")
				.all()
				.map((c) => c.name),
		);
		for (const column of MIGRATED_COLUMNS) {
			if (!existing.has(column)) {
				db.run(`ALTER TABLE mcp_tool_call_counts ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
			}
		}
		const upsert = db.query(UPSERT_SQL);
		let closed = false;
		let warned = false;
		return {
			record(tool, ok, failureClass) {
				if (closed) return;
				try {
					upsert.run({
						server: serverName,
						tool,
						failed: ok ? 0 : 1,
						badInput: !ok && failureClass === "bad-input" ? 1 : 0,
						unstructured: !ok && failureClass === "unstructured" ? 1 : 0,
						unknownTool: !ok && failureClass === "unknown-tool" ? 1 : 0,
						now: nowIso(),
					});
				} catch (error) {
					// Warn once per process, then stay silent: a broken metrics DB must
					// neither fail tool calls nor flood the logs.
					if (!warned) {
						warned = true;
						logger?.warn("tool-call metrics write failed (suppressing further warnings)", {
							dbPath,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			},
			close() {
				if (closed) return;
				closed = true;
				try {
					db.close(false);
				} catch {
					// best-effort: per-call upserts are already committed (WAL)
				}
			},
		};
	} catch (error) {
		logger?.warn("tool-call metrics disabled: cannot open database", {
			dbPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
