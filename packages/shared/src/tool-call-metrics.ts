// shared/src/tool-call-metrics.ts
// SIO-1400: opt-in per-server/per-tool call counters in a local SQLite file so
// under-used or error-prone MCP tools are visible. One row per (server, tool)
// with lifetime calls/failures. Enabled only when MCP_TOOL_METRICS_DB_PATH is
// set; several MCP server processes append to the same file (WAL + busy_timeout).
// Load-bearing rule: metrics must NEVER break a tool call -- every operation
// soft-fails, and a failed open disables the feature for the process.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ToolCallMetricsLogger {
	warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ToolCallMetricsRecorder {
	record(tool: string, ok: boolean): void;
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

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mcp_tool_call_counts (
	server TEXT NOT NULL,
	tool TEXT NOT NULL,
	calls INTEGER NOT NULL DEFAULT 0,
	failures INTEGER NOT NULL DEFAULT 0,
	first_called_at TEXT NOT NULL,
	last_called_at TEXT NOT NULL,
	PRIMARY KEY (server, tool)
)`;

const UPSERT_SQL = `
INSERT INTO mcp_tool_call_counts (server, tool, calls, failures, first_called_at, last_called_at)
VALUES ($server, $tool, 1, $failed, $now, $now)
ON CONFLICT (server, tool) DO UPDATE SET
	calls = calls + 1,
	failures = failures + excluded.failures,
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
		const upsert = db.query(UPSERT_SQL);
		let closed = false;
		let warned = false;
		return {
			record(tool, ok) {
				if (closed) return;
				try {
					upsert.run({ server: serverName, tool, failed: ok ? 0 : 1, now: nowIso() });
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
