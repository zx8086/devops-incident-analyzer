// knowledge-graph/src/store.ts
//
// SIO-850: GraphStore is the seam that makes "LadybugDB now, Neo4j later" a
// driver swap rather than a pipeline change. Pipeline writer/reader code speaks
// only this interface; the concrete store is selected here. LadybugStore is the
// embedded (in-process) implementation; a future Neo4jStore implements the same
// three methods and is the ONLY file that changes for the swap.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "@devops-agent/observability";
import { ALTER_MIGRATIONS, MIGRATIONS, VECTOR_INDEX_SETUP } from "./schema.ts";

const logger = getLogger("knowledge-graph:store");

export type GraphRow = Record<string, unknown>;

export interface GraphStore {
	// Idempotently apply the schema (and vector index where supported).
	init(): Promise<void>;
	// Execute a parameterized Cypher statement. Params are bound, never
	// string-interpolated, so the writer is injection-safe.
	run<T extends GraphRow = GraphRow>(cypher: string, params?: Record<string, unknown>): Promise<T[]>;
	close(): Promise<void>;
}

export function isKnowledgeGraphEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.KNOWLEDGE_GRAPH_ENABLED;
	return v === "true" || v === "1";
}

// SIO-1163 anchored the bare default at the repo root (found by walking up from
// this file's own location) to kill cwd ambiguity -- but that pointed at the
// WRONG directory: the app's real, historically-populated store has always
// lived at apps/web/.data/knowledge-graph, not <repo-root>/.data/knowledge-graph.
// SIO-1167 corrects this: anchor at apps/web specifically, still via a stable
// walk-up-for-a-marker-file (apps/web/package.json), not process.cwd() -- cwd
// still varies by launcher (apps/web's dev server runs from apps/web, cron/CLI
// scripts often run from the repo root), so a bare cwd-relative default would
// silently resolve to two different directories with no indication which one a
// given process had open (SIO-1129). Mirrors packages/agent/src/paths.ts's
// strategy, duplicated locally (not imported) because agent depends on
// knowledge-graph, not vice versa.
function findWebAppRoot(): string {
	try {
		let dir = dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 10; i++) {
			if (existsSync(join(dir, "apps", "web", "package.json"))) return join(dir, "apps", "web");
			const parent = resolve(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		// import.meta.url may not resolve in all environments
	}
	return process.cwd();
}

let loggedResolvedPath = false;

export function graphPath(env: NodeJS.ProcessEnv = process.env): string {
	const path =
		env.KNOWLEDGE_GRAPH_PATH && env.KNOWLEDGE_GRAPH_PATH !== ""
			? env.KNOWLEDGE_GRAPH_PATH
			: join(findWebAppRoot(), ".data/knowledge-graph");
	// SIO-1167: log the resolved path once per process at the point of decision,
	// not buried inside getGraphStore()'s IIFE -- SIO-1166's investigation lost
	// real time because nothing surfaced WHICH directory a live process had
	// actually opened; this one line would have made the repo-root misdirection
	// obvious immediately instead of requiring temporary source instrumentation.
	// Guarded to fire once (graphPath() is called from several places, incl. on
	// every test), not once per call.
	if (!loggedResolvedPath) {
		loggedResolvedPath = true;
		logger.info({ path }, "resolved knowledge-graph store path");
	}
	return path;
}

// SIO-1236: lbug throws (at least) three distinct messages for the SAME failure
// class -- a torn WAL tail left by an unclean process death, hit during replay:
//   - "Corrupted wal file. Read out invalid WAL record type." (wal_record.cpp)
//   - "Checksum verification failed, the WAL file is corrupted." (wal_replayer.cpp;
//     the common variant now that WAL checksums are on by default)
//   - "Reading past the end of the file ..." (buffered_file.cpp; SIO-1165's variant)
// All three are clean replay-time exceptions with a proven-safe recovery
// (quarantine the WAL, reopen the base file). Native asserts (KU_UNREACHABLE)
// stay excluded deliberately -- those can indicate base-file damage (SIO-1165).
const WAL_CORRUPTION_PATTERNS = [
	/corrupted wal file/i,
	/checksum verification failed/i,
	/reading past the end of the file/i,
];

function isWalCorruptionError(message: string): boolean {
	return WAL_CORRUPTION_PATTERNS.some((pattern) => pattern.test(message));
}

// SIO-1236: close() is a deliberate no-op (SIO-954 -- lbug's native finalizer
// segfaults Bun), so no process ever checkpoints at exit, and lbug's default
// auto-checkpoint threshold is 16MB -- far above this store's WAL sizes. The
// WAL therefore accumulated indefinitely, a permanently-open window any unclean
// death could tear (the root trigger behind SIO-1129/1163/1165). A low
// threshold keeps the WAL near-empty so there is almost nothing to tear.
const CHECKPOINT_THRESHOLD_BYTES = 256 * 1024;

// --- LadybugDB (lbug) embedded implementation -------------------------------
//
// lbug ships a native addon and is an OPTIONAL runtime dependency: install it
// (`bun add lbug`) and set KNOWLEDGE_GRAPH_ENABLED=true to activate. We load it
// through a variable specifier so this package typechecks and unit-tests WITHOUT
// the native module present, and so its real types never conflict if installed.

interface LbugQueryResult {
	getAll(): Promise<GraphRow[]>;
}
interface LbugPreparedStatement {
	isSuccess?(): boolean;
}
// lbug's query(statement, progressCallback?) does NOT take params; parameterized
// queries go through prepare() + execute(prepared, params). The store uses the
// param-less query() for DDL and prepare/execute for everything with bindings.
export interface LbugConnection {
	query(cypher: string): Promise<LbugQueryResult>;
	prepare(cypher: string): Promise<LbugPreparedStatement>;
	execute(prepared: LbugPreparedStatement, params: Record<string, unknown>): Promise<LbugQueryResult>;
}
export interface LbugDatabase {
	// Real API (lbug database.js): forces the lazy open -- and therefore WAL
	// replay -- to happen NOW instead of at the first query. Optional so fakes
	// and the InMemory store stay valid.
	init?(): Promise<void>;
	close?(): Promise<void> | void;
}
export interface LbugModule {
	// Positional ctor per lbug database.js: (path, bufferManagerSize,
	// enableCompression, readOnly, maxDBSize, autoCheckpoint, checkpointThreshold,
	// throwOnWalReplayFailure, enableChecksums). Only the first seven are passed;
	// throwOnWalReplayFailure stays true -- tolerant replay demonstrably leaves
	// broken in-memory state that crashes on first use (SIO-1165).
	Database: new (
		path: string,
		bufferManagerSize?: number,
		enableCompression?: boolean,
		readOnly?: boolean,
		maxDBSize?: number,
		autoCheckpoint?: boolean,
		checkpointThreshold?: number,
	) => LbugDatabase;
	Connection: new (db: LbugDatabase) => LbugConnection;
}

async function loadRealLbug(): Promise<LbugModule> {
	const specifier: string = "lbug";
	// Non-literal specifier -> TS does not statically resolve the module, so this
	// compiles without lbug installed. Resolved at runtime only when enabled.
	// @vite-ignore: the non-literal specifier is intentional; suppress Vite's
	// "dynamic import cannot be analyzed" SSR warning (lbug is an optional dep).
	const mod = (await import(/* @vite-ignore */ specifier)) as unknown as LbugModule;
	return mod;
}

// Test seam: override the lbug module LadybugStore loads, so the WAL-corruption
// classify/quarantine/retry path in openDatabase() below is exercisable without
// the native module installed. Pass undefined to restore the real loader.
let loadLbug: () => Promise<LbugModule> = loadRealLbug;
export function _setLbugLoaderForTesting(loader?: () => Promise<LbugModule>): void {
	loadLbug = loader ?? loadRealLbug;
}

export class LadybugStore implements GraphStore {
	private db: LbugDatabase | null = null;
	private conn: LbugConnection | null = null;

	constructor(private readonly path: string) {}

	private async connection(): Promise<LbugConnection> {
		if (this.conn) return this.conn;
		const dir = dirname(this.path);
		if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
		const lbug = await loadLbug();
		this.db = await this.openDatabase(lbug);
		this.conn = new lbug.Connection(this.db);
		return this.conn;
	}

	// SIO-1236: the Database constructor is LAZY (lbug's own docs: "the database
	// file is not opened until the first query is executed"), so WAL replay -- and
	// its corruption exception -- can fire either synchronously in the constructor
	// or later at the first query. Forcing db.init() here pins replay to a single
	// deterministic point INSIDE the recovery scope; SIO-1163's original catch
	// wrapped only the constructor and therefore usually never saw the error.
	private async newDatabase(lbug: LbugModule): Promise<LbugDatabase> {
		const db = new lbug.Database(this.path, 0, true, false, 0, true, CHECKPOINT_THRESHOLD_BYTES);
		if (db.init) {
			await db.init();
		} else {
			// Without init(), replay defers to the first query -- outside the recovery
			// scope, i.e. the exact SIO-1163 dead-code regression. Surface it loudly.
			logger.warn({ path: this.path }, "lbug Database has no init(); WAL-corruption auto-recovery may not fire");
		}
		return db;
	}

	// SIO-1163: a crash mid-write can leave the WAL in a state lbug's replay can't
	// parse, which otherwise poisons every future open of this store (SIO-1129).
	// Quarantine the unreplayable WAL and retry once against the base file -- the
	// same recovery already proven safe manually, just automatic. A second failure
	// (or a non-WAL error) rethrows unchanged; we never mask a genuinely different problem.
	private async openDatabase(lbug: LbugModule): Promise<LbugDatabase> {
		try {
			return await this.newDatabase(lbug);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!isWalCorruptionError(message)) throw error;
			const walPath = `${this.path}.wal`;
			if (existsSync(walPath)) {
				const quarantinePath = `${walPath}.corrupt-${Date.now()}`;
				renameSync(walPath, quarantinePath);
				logger.warn(
					{ path: this.path, quarantinePath, error: message },
					"corrupt WAL quarantined; retrying open against base file",
				);
			}
			// A FRESH instance, never the one whose replay failed -- it may hold
			// partially-replayed state (the SIO-1165 tolerant-replay lesson).
			return await this.newDatabase(lbug);
		}
	}

	async init(): Promise<void> {
		const conn = await this.connection();
		for (const ddl of MIGRATIONS) {
			await conn.query(ddl);
		}
		// SIO-965: additive column migrations for pre-existing graphs. Best-effort:
		// a bare ALTER throws "property already exists" once the column is present,
		// which is the steady state on every run after the first -- tolerate it so
		// init() stays idempotent. Same idiom as the vector-index loop below.
		for (const stmt of ALTER_MIGRATIONS) {
			try {
				await conn.query(stmt);
			} catch (error) {
				logger.debug(
					{ stmt, error: error instanceof Error ? error.message : String(error) },
					"alter migration skipped (column already exists?)",
				);
			}
		}
		// Vector index is best-effort: a build without the extension still gets a
		// working graph, just no similarity search.
		for (const stmt of VECTOR_INDEX_SETUP) {
			try {
				await conn.query(stmt);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// SIO-992: an "already exists" is the steady state on every run after the first (the
				// index persists with the graph), exactly like the ALTER loop above -- it is benign and
				// idempotent, so log it at debug, NOT warn. A warn here read as "extension unavailable?"
				// every session, implying a real failure that breaks similarity search when nothing was
				// wrong. Reserve the warn for a GENUINE setup failure (e.g. the extension truly missing).
				if (/already exists/i.test(message)) {
					logger.debug({ stmt }, "vector index already present (idempotent re-run)");
				} else {
					logger.warn({ stmt, error: message }, "vector index setup skipped (extension unavailable?)");
				}
			}
		}
		// SIO-1236: collapse any just-replayed WAL into the base file immediately
		// instead of leaving it in place until the auto-checkpoint threshold trips.
		// Best-effort: a store without CHECKPOINT support still works, just with a
		// longer torn-tail exposure window.
		try {
			await conn.query("CHECKPOINT");
		} catch (error) {
			logger.debug({ error: error instanceof Error ? error.message : String(error) }, "post-init checkpoint skipped");
		}
	}

	async run<T extends GraphRow = GraphRow>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
		const conn = await this.connection();
		// Bindings require prepare()+execute(); param-less statements (DDL, simple
		// reads) use query() directly. Both return a result with getAll().
		if (params && Object.keys(params).length > 0) {
			const prepared = await conn.prepare(cypher);
			const result = await conn.execute(prepared, params);
			return (await result.getAll()) as T[];
		}
		const result = await conn.query(cypher);
		return (await result.getAll()) as T[];
	}

	async close(): Promise<void> {
		// SIO-954: deliberately do NOT call the native db.close(). lbug's Database
		// destructor segfaults Bun's runtime at teardown (the panic reproduces with
		// the raw lbug API too -- it is a Bun + native-addon finalizer crash, not our
		// code). Embedded lbug flushes writes on every query, so durability does not
		// depend on an explicit close (verified: data survives a full re-open without
		// it). Dropping the references is enough; the OS reclaims the file handle on
		// process exit. Re-introducing db.close() crashes the migrate CLI and any
		// process that opens the graph -- this is why the feature stays usable.
		this.db = null;
		this.conn = null;
	}
}

// --- In-memory recording fake (tests / disabled fallback) -------------------
//
// Records executed statements and serves canned responses. Lets writer/reader
// logic be unit-tested (correct Cypher + bound params, result mapping) without
// the native engine.
export class InMemoryGraphStore implements GraphStore {
	readonly calls: Array<{ cypher: string; params?: Record<string, unknown> }> = [];
	private responses = new Map<string, GraphRow[]>();
	initialized = false;

	// Program a canned response for any query whose cypher contains `match`.
	stub(match: string, rows: GraphRow[]): void {
		this.responses.set(match, rows);
	}

	async init(): Promise<void> {
		this.initialized = true;
	}

	async run<T extends GraphRow = GraphRow>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
		this.calls.push({ cypher, params });
		for (const [match, rows] of this.responses) {
			if (cypher.includes(match)) return rows as T[];
		}
		return [] as T[];
	}

	async close(): Promise<void> {
		this.initialized = false;
	}
}

// --- Lazy singleton ---------------------------------------------------------

let storePromise: Promise<GraphStore> | null = null;

async function openRealStore(): Promise<GraphStore> {
	const path = graphPath();
	logger.debug({ path }, "opening knowledge-graph store");
	const store = new LadybugStore(path);
	await store.init();
	return store;
}

// Test seam: override how a fresh store is constructed (default: openRealStore).
// Lets tests exercise the reset-on-failure control flow in getGraphStore()
// without the native lbug module installed.
let storeFactory: () => Promise<GraphStore> = openRealStore;

// Returns the process-wide embedded store, initializing the schema on first
// use. Mirrors the agent's mcpReady/graphPromise memoization.
export function getGraphStore(): Promise<GraphStore> {
	if (!storePromise) {
		storePromise = storeFactory().catch((error) => {
			// SIO-1163: a rejected promise is a permanently cached rejection in JS --
			// without this reset, one transient failure (e.g. a WAL the auto-recovery
			// above couldn't repair) would poison every caller for the rest of the
			// process lifetime instead of getting a fresh attempt next time.
			storePromise = null;
			throw error;
		});
	}
	return storePromise;
}

// Test seam: inject a store (e.g. InMemoryGraphStore) and reset the singleton.
export function _setGraphStoreForTesting(store: GraphStore | null): void {
	storePromise = store ? Promise.resolve(store) : null;
}

// Test seam: override the factory getGraphStore() uses on a cache miss, and
// reset the singleton so the next call invokes it. Pass undefined to restore
// the real LadybugStore factory.
export function _setGraphStoreFactoryForTesting(factory?: () => Promise<GraphStore>): void {
	storeFactory = factory ?? openRealStore;
	storePromise = null;
}
