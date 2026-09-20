// shared/src/sqlite-open.ts

// SIO-1772: one SQLite opener for every consumer that can end up in a Node host.
// bun:sqlite stays the default; node:sqlite (Node >= 22.5) is the fallback for code
// bundled into the web app, whose dev host is `vite dev` under Node, where the
// "bun:" scheme fails with "Received protocol 'bun:'". Bun 1.3 does NOT implement
// node:sqlite ("No such built-in module"), so detection must prefer bun:sqlite
// under Bun -- the reverse fallback direction is impossible. Both drivers are
// sqlite3 on disk, so mixed Bun/Node processes share the same WAL DB safely.
//
// Extracted from tool-call-metrics.ts, which solved this first (SIO-1643). The
// evidence index (SIO-1688) copied only the bun half and was silently dead in dev.

// SIO-1858: `null` is part of the contract, not a widening of convenience. The
// first consumers (tool-call metrics, evidence index) bind only non-null counter
// columns, so the narrower type held; decision_metrics has nullable columns and
// a NULL is the correct value for "this run had no latency to report".
// Measured on both drivers before widening: null binds and reads back as null
// under bun:sqlite (strict) and node:sqlite (bare named params) alike, while
// `undefined` throws "Provided value cannot be bound" on node:sqlite and is
// silently stored as NULL by bun -- which is why callers normalize to null
// rather than leaving a field off.
export type SqliteParams = Record<string, string | number | null>;

export interface SqliteStatement {
	run(params?: SqliteParams): void;
	all<T>(params?: SqliteParams): T[];
}

export interface SqliteDb {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

export interface OpenSqliteOptions {
	// true: params bind by bare key ({ name } -> $name). false (default): keys carry
	// their prefix ({ $name }). Maps to bun's `strict` and node's
	// setAllowBareNamedParameters, which are the same switch under two names.
	bareNamedParameters?: boolean;
}

async function openBunSqlite(dbPath: string, bare: boolean): Promise<SqliteDb> {
	// Imported lazily: this package is bundled as source into the web app's Vite SSR
	// build (ssr.noExternal), where a top-level "bun:" specifier is unresolvable.
	// @vite-ignore keeps Vite from touching it.
	const { Database } = await import(/* @vite-ignore */ "bun:sqlite");
	const db = new Database(dbPath, { create: true, strict: bare });
	return {
		exec(sql) {
			db.run(sql);
		},
		prepare(sql) {
			const stmt = db.query(sql);
			return {
				run(params) {
					if (params) stmt.run(params);
					else stmt.run();
				},
				all<T>(params?: SqliteParams) {
					return (params ? stmt.all(params) : stmt.all()) as T[];
				},
			};
		},
		close() {
			db.close(false);
		},
	};
}

// SIO-1643: Node prints "ExperimentalWarning: SQLite is an experimental feature" the
// first time node:sqlite loads -- per-process noise on every `vite dev` boot. The
// predicate matches ONLY that warning so the scoped emitWarning swap in
// openNodeSqlite forwards everything else untouched. When Node passes an Error, its
// `name` carries the type (Node ignores the type argument then).
export function shouldSuppressNodeWarning(
	warning: string | Error,
	typeOrOptions?: string | { type?: string },
): boolean {
	const type =
		warning instanceof Error ? warning.name : typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
	const message = typeof warning === "string" ? warning : warning.message;
	return type === "ExperimentalWarning" && message.includes("SQLite");
}

type EmitWarning = typeof process.emitWarning;

type NodeSqlite = typeof import("node:sqlite");

// Memoized, so the process-wide emitWarning swap below happens at most once. Done per
// call it raced: concurrent first opens (per-run evidence indexes open lazily while the
// aws and elastic sub-agents run in parallel) each saved whatever handler was current,
// so a later caller captured an earlier caller's filter as "the original" and restored
// that -- leaving SQLite warnings suppressed for the life of the web process
// (Greptile, PR #805; reproduced under node with three concurrent opens).
let nodeSqliteImport: Promise<NodeSqlite> | undefined;

function importNodeSqlite(): Promise<NodeSqlite> {
	if (nodeSqliteImport) return nodeSqliteImport;
	// Node calls emitWarning synchronously while loading the builtin, so swapping it
	// for the duration of the import covers the whole window; `finally` restores it
	// even if the import throws (e.g. Node < 22.5 without node:sqlite).
	const originalEmitWarning: EmitWarning = process.emitWarning;
	const filtered = (warning: string | Error, typeOrOptions?: string | { type?: string }, ...rest: unknown[]): void => {
		if (shouldSuppressNodeWarning(warning, typeOrOptions)) return;
		Reflect.apply(originalEmitWarning, process, [warning, typeOrOptions, ...rest]);
	};
	process.emitWarning = filtered as unknown as EmitWarning;
	nodeSqliteImport = import(/* @vite-ignore */ "node:sqlite").finally(() => {
		process.emitWarning = originalEmitWarning;
	});
	return nodeSqliteImport;
}

async function openNodeSqlite(dbPath: string, bare: boolean): Promise<SqliteDb> {
	const { DatabaseSync } = await importNodeSqlite();
	const db = new DatabaseSync(dbPath);
	return {
		exec(sql) {
			db.exec(sql);
		},
		prepare(sql) {
			const stmt = db.prepare(sql);
			stmt.setAllowBareNamedParameters(bare);
			return {
				run(params) {
					if (params) stmt.run(params);
					else stmt.run();
				},
				all<T>(params?: SqliteParams) {
					return (params ? stmt.all(params) : stmt.all()) as T[];
				},
			};
		},
		close() {
			db.close();
		},
	};
}

export async function openSqlite(dbPath: string, options: OpenSqliteOptions = {}): Promise<SqliteDb> {
	const bare = options.bareNamedParameters ?? false;
	return typeof Bun === "undefined" ? openNodeSqlite(dbPath, bare) : openBunSqlite(dbPath, bare);
}
