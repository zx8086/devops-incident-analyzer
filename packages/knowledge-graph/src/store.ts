// knowledge-graph/src/store.ts
//
// SIO-850: GraphStore is the seam that makes "LadybugDB now, Neo4j later" a
// driver swap rather than a pipeline change. Pipeline writer/reader code speaks
// only this interface; the concrete store is selected here. LadybugStore is the
// embedded (in-process) implementation; a future Neo4jStore implements the same
// three methods and is the ONLY file that changes for the swap.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "@devops-agent/observability";
import { MIGRATIONS, VECTOR_INDEX_SETUP } from "./schema.ts";

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

export function graphPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.KNOWLEDGE_GRAPH_PATH && env.KNOWLEDGE_GRAPH_PATH !== ""
		? env.KNOWLEDGE_GRAPH_PATH
		: ".data/knowledge-graph";
}

// --- LadybugDB (lbug) embedded implementation -------------------------------
//
// lbug ships a native addon and is an OPTIONAL runtime dependency: install it
// (`bun add lbug`) and set KNOWLEDGE_GRAPH_ENABLED=true to activate. We load it
// through a variable specifier so this package typechecks and unit-tests WITHOUT
// the native module present, and so its real types never conflict if installed.

interface LbugConnection {
	query(cypher: string, params?: Record<string, unknown>): Promise<{ getAll(): Promise<GraphRow[]> }>;
}
interface LbugDatabase {
	close?(): Promise<void> | void;
}
interface LbugModule {
	Database: new (path: string) => LbugDatabase;
	Connection: new (db: LbugDatabase) => LbugConnection;
}

async function loadLbug(): Promise<LbugModule> {
	const specifier: string = "lbug";
	// Non-literal specifier -> TS does not statically resolve the module, so this
	// compiles without lbug installed. Resolved at runtime only when enabled.
	const mod = (await import(specifier)) as unknown as LbugModule;
	return mod;
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
		this.db = new lbug.Database(this.path);
		this.conn = new lbug.Connection(this.db);
		return this.conn;
	}

	async init(): Promise<void> {
		const conn = await this.connection();
		for (const ddl of MIGRATIONS) {
			await conn.query(ddl);
		}
		// Vector index is best-effort: a build without the extension still gets a
		// working graph, just no similarity search.
		for (const stmt of VECTOR_INDEX_SETUP) {
			try {
				await conn.query(stmt);
			} catch (error) {
				logger.warn(
					{ stmt, error: error instanceof Error ? error.message : String(error) },
					"vector index setup skipped (extension unavailable?)",
				);
			}
		}
	}

	async run<T extends GraphRow = GraphRow>(cypher: string, params?: Record<string, unknown>): Promise<T[]> {
		const conn = await this.connection();
		const result = await conn.query(cypher, params);
		return (await result.getAll()) as T[];
	}

	async close(): Promise<void> {
		await this.db?.close?.();
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

// Returns the process-wide embedded store, initializing the schema on first
// use. Mirrors the agent's mcpReady/graphPromise memoization.
export function getGraphStore(): Promise<GraphStore> {
	if (!storePromise) {
		storePromise = (async () => {
			const store = new LadybugStore(graphPath());
			await store.init();
			return store;
		})();
	}
	return storePromise;
}

// Test seam: inject a store (e.g. InMemoryGraphStore) and reset the singleton.
export function _setGraphStoreForTesting(store: GraphStore | null): void {
	storePromise = store ? Promise.resolve(store) : null;
}
