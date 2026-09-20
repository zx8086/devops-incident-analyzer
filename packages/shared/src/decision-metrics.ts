// shared/src/decision-metrics.ts
// SIO-1858: per-decision rows for the Jev (TypeSafe System One) seams. Separate
// from tool-call-metrics.ts on purpose: that table is an upsert COUNTER keyed
// (server, tool) holding lifetime totals, which cannot answer "before vs after"
// for any window, cannot see a non-MCP call (Jev is not an MCP tool), and
// measures success rather than quality -- findLinkedIncidents reads 98 calls /
// 0 failures precisely because it never errors, it returns the wrong tickets.
// One row per decision, so every Jev sub-issue's "measured latency, tokens and
// cost" acceptance criterion has somewhere to live.
// Load-bearing rule, inherited from tool-call-metrics.ts: metrics must NEVER
// break a request -- every operation soft-fails and a failed open disables the
// feature for the process.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqlite, type SqliteDb } from "./sqlite-open.ts";

export interface DecisionMetricsLogger {
	warn(message: string, meta?: Record<string, unknown>): void;
}

// Whether the seam used the model's answer, fell back to the deterministic path
// on purpose (flag off, no key, nothing to rank), or fell back because the call
// failed. The applied/failed ratio IS the safety property every sub-issue
// promises, so it has to be a column rather than a log line.
export type DecisionOutcome = "applied" | "skipped" | "failed";

export interface DecisionRecord {
	// Which seam produced this row, e.g. "atlassian-rerank". Free text rather than
	// a union: a new seam must not need a shared-package change to start recording.
	seam: string;
	outcome: DecisionOutcome;
	requestId?: string;
	// The versioned id the API answered with (response.model), not the alias sent.
	model?: string;
	latencyMs?: number;
	inputTokens?: number;
	itemsIn?: number;
	itemsDropped?: number;
	topScore?: number;
	bottomScore?: number;
	// SIO-1858: the actual question behind the epic -- how often the model
	// disagreed with the arithmetic it replaces. Spearman's rho over the two
	// orderings, in [-1, 1]; 1 is identical order, 0 unrelated, -1 reversed.
	// Undefined when fewer than two items make the comparison meaningless.
	rankCorrelation?: number;
	// Why an "applied" run still produced nothing, or why it failed. An enum-ish
	// short string, never upstream error text: this DB is read by humans and the
	// repo is public.
	note?: string;
}

export interface DecisionMetricsRecorder {
	record(entry: DecisionRecord): void;
	close(): void;
}

export function resolveDecisionMetricsDbPath(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	// Same guard as resolveToolCallMetricsDbPath: bun test sets NODE_ENV=test and
	// auto-loads .env, so without this every test that exercises a seam would
	// write fake rows into the developer's real DB.
	if (env.NODE_ENV === "test") return undefined;
	const raw = env.DECISION_METRICS_DB_PATH?.trim();
	return raw ? raw : undefined;
}

// No PRIMARY KEY: these are events, not counters. `at` is ISO-8601 so string
// ordering is chronological ordering.
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS decision_metrics (
	at TEXT NOT NULL,
	seam TEXT NOT NULL,
	outcome TEXT NOT NULL,
	request_id TEXT,
	model TEXT,
	latency_ms INTEGER,
	input_tokens INTEGER,
	items_in INTEGER,
	items_dropped INTEGER,
	top_score REAL,
	bottom_score REAL,
	rank_correlation REAL,
	note TEXT
)`;

// Queries are "this seam, this window", so the index leads with seam and carries
// `at` for the range scan.
const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS decision_metrics_seam_at ON decision_metrics (seam, at)`;

const INSERT_SQL = `
INSERT INTO decision_metrics (
	at, seam, outcome, request_id, model, latency_ms, input_tokens,
	items_in, items_dropped, top_score, bottom_score, rank_correlation, note
)
VALUES (
	$at, $seam, $outcome, $requestId, $model, $latencyMs, $inputTokens,
	$itemsIn, $itemsDropped, $topScore, $bottomScore, $rankCorrelation, $note
)`;

// Every optional field is normalized to null before it reaches the statement.
// Measured, not assumed: bun:sqlite in strict mode ACCEPTS an undefined binding
// and stores NULL, so this is not load-bearing there. It is load-bearing for the
// node:sqlite fallback (sqlite-open.ts, SIO-1772), whose bindings reject
// undefined, and it keeps the two drivers writing identical rows.
function orNull(value: string | number | undefined): string | number | null {
	return value === undefined ? null : value;
}

/**
 * Fractional ranks, ties sharing their average position (1-based).
 *
 * [10, 20, 20, 40] -> [1, 2.5, 2.5, 4]. This is the transform that makes
 * Pearson-on-ranks equal Spearman when ties are present.
 */
function averageRanks(values: readonly number[]): number[] {
	const order = values.map((value, index) => ({ value, index })).sort((x, y) => x.value - y.value);
	const ranks = new Array<number>(values.length);
	let i = 0;
	while (i < order.length) {
		let j = i;
		while (
			j + 1 < order.length &&
			(order[j + 1] as { value: number }).value === (order[i] as { value: number }).value
		) {
			j += 1;
		}
		// Positions i..j are tied; they all take the midpoint of the span.
		const shared = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) ranks[(order[k] as { index: number }).index] = shared;
		i = j + 1;
	}
	return ranks;
}

/**
 * Spearman's rank correlation between two orderings of the same items.
 *
 * Both arrays hold a position or score for the same item at the same index, on
 * any consistent scale; they are rank-transformed here, so the caller does not
 * have to pre-rank them. Returns undefined when there are fewer than 2 items,
 * when the lengths disagree, or when either side is a flat tie -- in all of those
 * the coefficient is undefined rather than 0, and reporting 0 would read as
 * "unrelated orderings" instead of "not answerable".
 *
 * Greptile PR #868: this previously ran Pearson over the RAW inputs and called
 * the result Spearman. Without ties the two agree, which is why the tests passed;
 * with them they do not (measured: [0,1,1,3] vs [0,1,2,3] gives 0.923381 raw
 * against 0.948683 true). Tied model scores are expected here -- two tickets can
 * be equally relevant -- so the transform is not optional.
 */
export function rankCorrelation(a: readonly number[], b: readonly number[]): number | undefined {
	if (a.length !== b.length || a.length < 2) return undefined;
	const ra = averageRanks(a);
	const rb = averageRanks(b);
	const n = ra.length;
	const meanA = ra.reduce((s, v) => s + v, 0) / n;
	const meanB = rb.reduce((s, v) => s + v, 0) / n;
	let cov = 0;
	let varA = 0;
	let varB = 0;
	for (let i = 0; i < n; i++) {
		const da = (ra[i] as number) - meanA;
		const db = (rb[i] as number) - meanB;
		cov += da * db;
		varA += da * da;
		varB += db * db;
	}
	if (varA === 0 || varB === 0) return undefined;
	return cov / Math.sqrt(varA * varB);
}

export async function createDecisionMetricsRecorder(options: {
	dbPath: string;
	logger?: DecisionMetricsLogger;
	nowIso?: () => string;
	// Test seam. A leaked handle is invisible from outside: bun:sqlite lets a
	// second connection read and write while the first is open (measured), so the
	// only way to observe that a failed setup released its database is to watch the
	// handle's own close. Production always uses openSqlite.
	openDb?: (dbPath: string) => Promise<SqliteDb>;
}): Promise<DecisionMetricsRecorder | undefined> {
	const { dbPath, logger } = options;
	const nowIso = options.nowIso ?? (() => new Date().toISOString());
	// Greptile PR #868: hoisted so the catch can close a handle that opened and
	// then failed on a PRAGMA, the schema, the index or the prepare. Returning
	// undefined hands the caller no way to release it, so the descriptor would
	// stay open for the life of the process.
	let db: SqliteDb | undefined;
	try {
		mkdirSync(dirname(dbPath), { recursive: true });
		// bareNamedParameters matches INSERT_SQL's bare $keys.
		db = options.openDb ? await options.openDb(dbPath) : await openSqlite(dbPath, { bareNamedParameters: true });
		// busy_timeout BEFORE journal_mode, the ordering SIO-1400 measured: the WAL
		// switch takes a lock, and with no busy handler a concurrent opener fails
		// instantly with "database is locked".
		db.exec("PRAGMA busy_timeout = 5000;");
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec(CREATE_TABLE_SQL);
		db.exec(CREATE_INDEX_SQL);
		const insert = db.prepare(INSERT_SQL);
		const opened = db;
		let closed = false;
		let warned = false;
		return {
			record(entry) {
				if (closed) return;
				try {
					insert.run({
						at: nowIso(),
						seam: entry.seam,
						outcome: entry.outcome,
						requestId: orNull(entry.requestId),
						model: orNull(entry.model),
						latencyMs: orNull(entry.latencyMs),
						inputTokens: orNull(entry.inputTokens),
						itemsIn: orNull(entry.itemsIn),
						itemsDropped: orNull(entry.itemsDropped),
						topScore: orNull(entry.topScore),
						bottomScore: orNull(entry.bottomScore),
						rankCorrelation: orNull(entry.rankCorrelation),
						note: orNull(entry.note),
					});
				} catch (error) {
					// Warn once per process, then stay silent: a broken metrics DB must
					// neither fail a turn nor flood the logs.
					if (!warned) {
						warned = true;
						logger?.warn("decision metrics write failed (suppressing further warnings)", {
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
					opened.close();
				} catch {
					// best-effort: rows are already committed (WAL)
				}
			},
		};
	} catch (error) {
		try {
			db?.close();
		} catch {
			// The open itself may be what failed; nothing to release then.
		}
		logger?.warn("decision metrics disabled: cannot open database", {
			dbPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
