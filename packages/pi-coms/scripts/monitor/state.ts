// scripts/monitor/state.ts
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

// `chat` is an operator's `suppress` command, `file` comes from the committed
// manifest. Reconcile only ever removes `file` rows (see reconcileFileSuppressions).
export type SuppressionSource = "chat" | "file";

export class MonitorState {
	private db: Database;
	constructor(dbPath: string) {
		if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS watermarks (key TEXT PRIMARY KEY, ts INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS fingerprints (key TEXT PRIMARY KEY, family TEXT NOT NULL, first_alerted INTEGER NOT NULL, last_alerted INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS snapshots (name TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS costs (date TEXT PRIMARY KEY, usd REAL NOT NULL);
			CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS unsent (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, prompt TEXT NOT NULL, ttl_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS suppressions (pattern TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'chat');
		`);
		// Every deployed host already has a suppressions table without `source`,
		// and CREATE TABLE IF NOT EXISTS silently leaves it alone. Add the column
		// in place; the DEFAULT backfills existing rows as 'chat', which is what
		// they are -- every entry predating this was typed by an operator.
		if (!this.hasColumn("suppressions", "source")) {
			this.db.exec("ALTER TABLE suppressions ADD COLUMN source TEXT NOT NULL DEFAULT 'chat'");
		}
	}

	private hasColumn(table: string, column: string): boolean {
		const rows = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
		return rows.some((r) => r.name === column);
	}
	close(): void {
		try {
			this.db.close();
		} catch {}
	}

	// Checkpoint seam (SIO-1745): the db handle stays private, so the backup
	// path borrows it here rather than reaching through the class.
	withDb<T>(fn: (db: Database) => T): T {
		return fn(this.db);
	}

	getWatermark(key: string): number | null {
		const r = this.db.query("SELECT ts FROM watermarks WHERE key = ?").get(key) as { ts: number } | null;
		return r ? Number(r.ts) : null;
	}
	setWatermark(key: string, ts: number): void {
		this.db
			.query("INSERT INTO watermarks (key, ts) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts")
			.run(key, ts);
	}

	// true when never alerted, or when reAlertMs is given and the last alert is
	// older than it. Omitted reAlertMs means alert once until cleared.
	shouldAlert(key: string, reAlertMs?: number): boolean {
		const r = this.db.query("SELECT last_alerted FROM fingerprints WHERE key = ?").get(key) as {
			last_alerted: number;
		} | null;
		if (!r) return true;
		if (reAlertMs === undefined) return false;
		return Date.now() - Number(r.last_alerted) > reAlertMs;
	}
	markAlerted(key: string, family: string): void {
		const now = Date.now();
		this.db
			.query(
				`INSERT INTO fingerprints (key, family, first_alerted, last_alerted) VALUES (?, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET last_alerted = excluded.last_alerted`,
			)
			.run(key, family, now, now);
	}
	clearAlerts(prefix: string): void {
		this.db.query("DELETE FROM fingerprints WHERE key LIKE ? || '%'").run(prefix);
	}
	alertKeys(prefix: string): string[] {
		return (
			this.db.query("SELECT key FROM fingerprints WHERE key LIKE ? || '%' ORDER BY key").all(prefix) as {
				key: string;
			}[]
		).map((r) => r.key);
	}

	getSnapshot(name: string): Record<string, string> | null {
		const r = this.db.query("SELECT value FROM snapshots WHERE name = ?").get(name) as { value: string } | null;
		return r ? JSON.parse(r.value) : null;
	}
	setSnapshot(name: string, v: Record<string, string>): void {
		this.db
			.query("INSERT INTO snapshots (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
			.run(name, JSON.stringify(v));
	}

	recordCost(date: string, usd: number): void {
		this.db
			.query("INSERT INTO costs (date, usd) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET usd = excluded.usd")
			.run(date, usd);
	}
	costBaseline(excludeDate: string, days: number): number | null {
		const rows = this.db
			.query("SELECT usd FROM costs WHERE date < ? ORDER BY date DESC LIMIT ?")
			.all(excludeDate, days) as { usd: number }[];
		if (rows.length === 0) return null;
		// Median, not mean (SIO-1739): one spike day inflated the mean for the
		// next two weeks and hid every rise under it.
		const sorted = rows.map((r) => Number(r.usd)).sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		// 14 days is even: the mean of the two middle days, or the baseline
		// would sit on the upper one and hide a rise near the threshold.
		return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	}
	latestCost(): { date: string; usd: number } | null {
		const r = this.db.query("SELECT date, usd FROM costs ORDER BY date DESC LIMIT 1").get() as {
			date: string;
			usd: number;
		} | null;
		return r ? { date: r.date, usd: Number(r.usd) } : null;
	}

	journal(kind: string, payload: unknown): void {
		const now = new Date();
		this.db
			.query("INSERT INTO journal (ts, ts_ms, kind, payload) VALUES (?, ?, ?, ?)")
			.run(now.toISOString(), now.getTime(), kind, JSON.stringify(payload));
	}
	journalRows(sinceMs: number, kind?: string): { ts: string; kind: string; payload: string }[] {
		const cutoff = Date.now() - sinceMs;
		const rows = kind
			? this.db
					.query("SELECT ts, kind, payload FROM journal WHERE ts_ms >= ? AND kind = ? ORDER BY id ASC")
					.all(cutoff, kind)
			: this.db.query("SELECT ts, kind, payload FROM journal WHERE ts_ms >= ? ORDER BY id ASC").all(cutoff);
		return rows as { ts: string; kind: string; payload: string }[];
	}
	// History is kept, not hoarded: findings older than the retention window
	// stop informing anything and only grow the db.
	pruneJournal(retainMs: number): number {
		const cutoff = Date.now() - retainMs;
		return this.db.query("DELETE FROM journal WHERE ts_ms < ?").run(cutoff).changes;
	}
	priorIncidents(resource: string, limit: number): { ts: string; payload: string }[] {
		return this.db
			.query(
				"SELECT ts, payload FROM journal WHERE kind = 'finding' AND payload LIKE '%' || ? || '%' ORDER BY id DESC LIMIT ?",
			)
			.all(resource, limit) as { ts: string; payload: string }[];
	}
	// The newest finding row for this exact dedup_key that carries a diagnosis
	// the agent actually produced (a reused one is excluded, or a flapping alarm
	// could ride one diagnosis forever) inside the window (SIO-1739).
	priorDiagnosis(dedupKey: string, sinceMs: number): { ts: string; diagnosis: unknown } | null {
		const r = this.db
			.query(
				`SELECT ts, json_extract(payload, '$.diagnosis') AS diagnosis FROM journal
				WHERE kind = 'finding' AND ts_ms >= ?
				AND json_extract(payload, '$.dedup_key') = ?
				AND json_extract(payload, '$.diagnosis') IS NOT NULL
				AND json_extract(payload, '$.reused_from') IS NULL
				ORDER BY id DESC LIMIT 1`,
			)
			.get(Date.now() - sinceMs, dedupKey) as { ts: string; diagnosis: string } | null;
		if (!r) return null;
		try {
			return { ts: r.ts, diagnosis: JSON.parse(r.diagnosis) };
		} catch {
			return null;
		}
	}

	// The known-gap ledger: operator-accepted imperfections stop re-raising as
	// fresh findings. Patterns are SQL LIKE against dedup_key ("%" wildcards),
	// so one entry can cover a family (e.g. "alarm:%-Utilization-Low-20%").
	addSuppression(pattern: string, reason: string, source: SuppressionSource = "chat"): void {
		this.db
			.query(
				"INSERT INTO suppressions (pattern, reason, created_at, source) VALUES (?, ?, ?, ?) ON CONFLICT(pattern) DO UPDATE SET reason = excluded.reason, source = excluded.source",
			)
			.run(pattern, reason, new Date().toISOString(), source);
	}
	removeSuppression(pattern: string): boolean {
		return this.db.query("DELETE FROM suppressions WHERE pattern = ?").run(pattern).changes > 0;
	}
	listSuppressions(): { pattern: string; reason: string; created_at: string; source: SuppressionSource }[] {
		return this.db
			.query("SELECT pattern, reason, created_at, source FROM suppressions ORDER BY created_at ASC")
			.all() as {
			pattern: string;
			reason: string;
			created_at: string;
			source: SuppressionSource;
		}[];
	}

	// SIO-1868: the file-sourced half of the ledger, reconciled at startup from a
	// committed manifest so a fleet-wide suppression is a reviewed diff rather
	// than N chat commands that die with the instance.
	//
	// Only `file` rows are removed. An operator's `suppress` during an incident
	// is a `chat` row and must survive reconcile -- a blanket delete-and-reinsert
	// would drop it silently, which is the one failure mode that would make an
	// operator stop trusting the ledger. A pattern that appears in both wins as
	// `file`: the manifest is the reviewed source, and the chat row was the
	// stop-gap it replaces.
	reconcileFileSuppressions(entries: { pattern: string; reason: string }[]): {
		added: string[];
		updated: string[];
		removed: string[];
	} {
		const wanted = new Map(entries.map((e) => [e.pattern, e.reason]));
		const existing = this.listSuppressions();
		const byPattern = new Map(existing.map((r) => [r.pattern, r]));
		const added: string[] = [];
		const updated: string[] = [];
		const removed: string[] = [];
		for (const [pattern, reason] of wanted) {
			const row = byPattern.get(pattern);
			if (!row) added.push(pattern);
			else if (row.reason !== reason || row.source !== "file") updated.push(pattern);
			else continue;
			this.addSuppression(pattern, reason, "file");
		}
		for (const row of existing) {
			if (row.source !== "file" || wanted.has(row.pattern)) continue;
			this.removeSuppression(row.pattern);
			removed.push(row.pattern);
		}
		return { added, updated, removed };
	}
	matchSuppression(dedupKey: string): { pattern: string; reason: string } | null {
		const r = this.db.query("SELECT pattern, reason FROM suppressions WHERE ? LIKE pattern LIMIT 1").get(dedupKey) as {
			pattern: string;
			reason: string;
		} | null;
		return r ? { pattern: r.pattern, reason: r.reason } : null;
	}

	queueUnsent(target: string, prompt: string, ttlMs: number): void {
		this.db
			.query("INSERT INTO unsent (target, prompt, ttl_ms, created_at) VALUES (?, ?, ?, ?)")
			.run(target, prompt, ttlMs, new Date().toISOString());
	}
	unsent(): { id: number; target: string; prompt: string; ttl_ms: number }[] {
		return this.db.query("SELECT id, target, prompt, ttl_ms FROM unsent ORDER BY id ASC").all() as {
			id: number;
			target: string;
			prompt: string;
			ttl_ms: number;
		}[];
	}
	deleteUnsent(id: number): void {
		this.db.query("DELETE FROM unsent WHERE id = ?").run(id);
	}
}
