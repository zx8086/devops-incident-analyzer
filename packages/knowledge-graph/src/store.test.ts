// knowledge-graph/src/store.test.ts

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	_setGraphStoreFactoryForTesting,
	_setLbugLoaderForTesting,
	getGraphStore,
	graphPath,
	InMemoryGraphStore,
	LadybugStore,
	type LbugConnection,
	type LbugDatabase,
	type LbugModule,
} from "./store.ts";

interface MockLbug {
	loader: () => Promise<LbugModule>;
	counts: { ctor: number; init: number };
	ctorArgs: unknown[][];
	queries: string[];
}

// Builds a fake lbug module modeling the REAL module's lazy-open contract
// (SIO-1236): the Database constructor can throw synchronously, but WAL replay
// errors can equally surface from db.init() -- lbug's own docs: "the database
// file is not opened until the first query is executed". Connections answer
// empty result sets and record executed cypher.
function mockLbug(opts: {
	ctorThrows?: (call: number) => Error | undefined;
	initThrows?: (call: number) => Error | undefined;
	queryThrows?: (cypher: string) => Error | undefined;
}): MockLbug {
	const counts = { ctor: 0, init: 0 };
	const ctorArgs: unknown[][] = [];
	const queries: string[] = [];
	const loader = async () =>
		({
			Database: class {
				constructor(...args: unknown[]) {
					counts.ctor += 1;
					ctorArgs.push(args);
					const err = opts.ctorThrows?.(counts.ctor);
					if (err) throw err;
				}
				async init() {
					counts.init += 1;
					const err = opts.initThrows?.(counts.init);
					if (err) throw err;
				}
			} as unknown as new (
				dbPath: string,
			) => LbugDatabase,
			Connection: class {
				async query(cypher: string) {
					queries.push(cypher);
					const err = opts.queryThrows?.(cypher);
					if (err) throw err;
					return { getAll: async () => [] };
				}
				async prepare() {
					return {};
				}
				async execute() {
					return { getAll: async () => [] };
				}
			} as unknown as new (
				db: LbugDatabase,
			) => LbugConnection,
		}) as LbugModule;
	return { loader, counts, ctorArgs, queries };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "kg-store-test-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("graphPath", () => {
	test("returns the env override verbatim when set", () => {
		expect(graphPath({ KNOWLEDGE_GRAPH_PATH: "/custom/path" } as NodeJS.ProcessEnv)).toBe("/custom/path");
	});

	test("resolves the bare default to an absolute path anchored at apps/web, not the repo root or cwd", () => {
		// SIO-1167: an earlier anchor at the repo root (not apps/web) silently
		// redirected the whole app to a different, stale store with no error --
		// assert the actual expected directory, not just "some absolute path".
		const path = graphPath({} as NodeJS.ProcessEnv);
		expect(isAbsolute(path)).toBe(true);
		expect(path.endsWith(join("apps", "web", ".data", "knowledge-graph"))).toBe(true);
		expect(path).not.toBe(join(process.cwd(), ".data/knowledge-graph"));
	});

	test("ignores an empty-string override and falls back to the absolute default", () => {
		const path = graphPath({ KNOWLEDGE_GRAPH_PATH: "" } as NodeJS.ProcessEnv);
		expect(isAbsolute(path)).toBe(true);
	});
});

describe("getGraphStore singleton reset-on-failure", () => {
	// Restore the real LadybugStore factory once this suite finishes so later
	// test files in the same process aren't left pointed at a test double.
	afterAll(() => _setGraphStoreFactoryForTesting(undefined));

	test("resets the singleton after a rejected factory so the next call retries", async () => {
		let attempts = 0;
		_setGraphStoreFactoryForTesting(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("Runtime exception: Corrupted wal file. Read out invalid WAL record type.");
			return new InMemoryGraphStore();
		});

		await expect(getGraphStore()).rejects.toThrow(/corrupted wal file/i);
		// A permanently-cached rejection would reject again here with the SAME error
		// instead of re-invoking the factory -- this is the exact bug SIO-1163 fixes.
		const store = await getGraphStore();
		expect(store).toBeInstanceOf(InMemoryGraphStore);
		expect(attempts).toBe(2);
	});

	test("caches a successful store across calls (no redundant re-open)", async () => {
		let attempts = 0;
		_setGraphStoreFactoryForTesting(async () => {
			attempts += 1;
			return new InMemoryGraphStore();
		});

		const first = await getGraphStore();
		const second = await getGraphStore();
		expect(first).toBe(second);
		expect(attempts).toBe(1);
	});
});

describe("LadybugStore WAL-corruption recovery", () => {
	// Restore the real lbug loader once this suite finishes.
	afterAll(() => _setLbugLoaderForTesting(undefined));

	const CORRUPT_WAL_ERROR = "Runtime exception: Corrupted wal file. Read out invalid WAL record type.";

	test("quarantines the .wal file and retries once on a corrupt-WAL error", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			_setLbugLoaderForTesting(
				mockLbug({ ctorThrows: (call) => (call === 1 ? new Error(CORRUPT_WAL_ERROR) : undefined) }).loader,
			);

			const store = new LadybugStore(path);
			await store.run("MATCH (n) RETURN n");

			expect(existsSync(walPath)).toBe(false);
			const quarantined = readdirSync(dir).filter((f) => f.startsWith("knowledge-graph.wal.corrupt-"));
			expect(quarantined.length).toBe(1);
		}));

	test("rethrows unchanged when the retry also fails, but still quarantines the .wal first", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			_setLbugLoaderForTesting(mockLbug({ ctorThrows: () => new Error(CORRUPT_WAL_ERROR) }).loader);

			const store = new LadybugStore(path);
			await expect(store.run("MATCH (n) RETURN n")).rejects.toThrow(/corrupted wal file/i);
			// quarantine runs before the retry, independent of whether the retry succeeds
			expect(existsSync(walPath)).toBe(false);
			const quarantined = readdirSync(dir).filter((f) => f.startsWith("knowledge-graph.wal.corrupt-"));
			expect(quarantined.length).toBe(1);
		}));

	test("rethrows a non-WAL error immediately without touching the .wal file", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			const mock = mockLbug({ ctorThrows: () => new Error("IO exception: Could not set lock on file") });
			_setLbugLoaderForTesting(mock.loader);

			const store = new LadybugStore(path);
			await expect(store.run("MATCH (n) RETURN n")).rejects.toThrow(/could not set lock/i);
			expect(mock.counts.ctor).toBe(1);
			expect(existsSync(walPath)).toBe(true);
		}));

	// SIO-1236: the live 2026-07-26 recurrence. lbug enables WAL checksums by
	// default, so a torn WAL tail now surfaces as this message (wal_replayer.cpp)
	// instead of the "Corrupted wal file" variant SIO-1163's regex matched -- and
	// because the Database constructor is lazy, it surfaces from init(), not the
	// constructor. Both gaps together made the auto-recovery dead code.
	const CHECKSUM_WAL_ERROR = "Storage exception: Checksum verification failed, the WAL file is corrupted.";
	const PAST_EOF_WAL_ERROR =
		"Runtime exception: Reading past the end of the file. Reading 40 bytes with size 419001 at offset 419000.";

	test("recovers when the checksum-variant error surfaces from init(), rebuilding a FRESH Database", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			const mock = mockLbug({ initThrows: (call) => (call === 1 ? new Error(CHECKSUM_WAL_ERROR) : undefined) });
			_setLbugLoaderForTesting(mock.loader);

			const store = new LadybugStore(path);
			await store.run("MATCH (n) RETURN n");

			expect(existsSync(walPath)).toBe(false);
			const quarantined = readdirSync(dir).filter((f) => f.startsWith("knowledge-graph.wal.corrupt-"));
			expect(quarantined.length).toBe(1);
			// The retry must NOT reuse the Database whose replay failed -- it may
			// hold partially-replayed state. Assert a fresh construction + init.
			expect(mock.counts.ctor).toBe(2);
			expect(mock.counts.init).toBe(2);
		}));

	test("recovers from the past-EOF torn-tail variant (SIO-1165) thrown by the constructor", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			_setLbugLoaderForTesting(
				mockLbug({ ctorThrows: (call) => (call === 1 ? new Error(PAST_EOF_WAL_ERROR) : undefined) }).loader,
			);

			const store = new LadybugStore(path);
			await store.run("MATCH (n) RETURN n");

			expect(existsSync(walPath)).toBe(false);
			const quarantined = readdirSync(dir).filter((f) => f.startsWith("knowledge-graph.wal.corrupt-"));
			expect(quarantined.length).toBe(1);
		}));

	test("rethrows a non-WAL error from init() without touching the .wal file", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			const mock = mockLbug({ initThrows: () => new Error("Buffer manager exception: Failed to claim frame") });
			_setLbugLoaderForTesting(mock.loader);

			const store = new LadybugStore(path);
			await expect(store.run("MATCH (n) RETURN n")).rejects.toThrow(/failed to claim frame/i);
			expect(mock.counts.ctor).toBe(1);
			expect(existsSync(walPath)).toBe(true);
		}));

	test("rethrows when the retry's init() also fails, but still quarantines the .wal first", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			const mock = mockLbug({ initThrows: () => new Error(CHECKSUM_WAL_ERROR) });
			_setLbugLoaderForTesting(mock.loader);

			const store = new LadybugStore(path);
			await expect(store.run("MATCH (n) RETURN n")).rejects.toThrow(/checksum verification failed/i);
			expect(existsSync(walPath)).toBe(false);
			const quarantined = readdirSync(dir).filter((f) => f.startsWith("knowledge-graph.wal.corrupt-"));
			expect(quarantined.length).toBe(1);
			expect(mock.counts.ctor).toBe(2);
		}));

	// SIO-1361 (reversing SIO-1339's reading): this garbled IO exception with a
	// nonsense byte position (live-observed: "position: 4901969379328" against a
	// 92MB file, "numBytesRead: 0") is persistent BASE-FILE damage, proven live
	// with zero lock holders and a byte-identical failure on a copy of the file
	// with and without its WAL. It does NOT match any WAL_CORRUPTION_PATTERNS and
	// must NOT be quarantine-and-retried (the WAL is healthy; quarantining it
	// would destroy real data for no reason, and retrying fails identically). It
	// surfaces as a clear error pointing the operator at knowledge-graph:rebuild.
	const BASE_FILE_DAMAGE_ERROR =
		"IO exception: Cannot read from file: /data/knowledge-graph fileDescriptor: 48 numBytesRead: 0 numBytesToRead: 4096 position: 4901969379328";

	test("does not quarantine the .wal file for a base-file-damage IO exception", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "a healthy wal file, not corrupt");

			const mock = mockLbug({ ctorThrows: () => new Error(BASE_FILE_DAMAGE_ERROR) });
			_setLbugLoaderForTesting(mock.loader);

			const store = new LadybugStore(path);
			await expect(store.run("MATCH (n) RETURN n")).rejects.toThrow(/base file appears corrupted/i);
			// The healthy WAL must survive -- this is not WAL corruption, so it must not be quarantined.
			expect(existsSync(walPath)).toBe(true);
			expect(mock.counts.ctor).toBe(1);
		}));

	// SIO-967/SIO-1361: TRUE cross-process lock contention has its own clean message
	// shape; it must surface as a lock-held error, with no quarantine and no retry.
	const LOCK_HELD_ERROR = "IO exception: Could not set lock on file : /data/knowledge-graph";

	test("does not quarantine the .wal file when another process holds the lock", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "a healthy wal file, not corrupt");

			const mock = mockLbug({ ctorThrows: () => new Error(LOCK_HELD_ERROR) });
			_setLbugLoaderForTesting(mock.loader);

			const store = new LadybugStore(path);
			await expect(store.run("MATCH (n) RETURN n")).rejects.toThrow(/exclusive file lock/i);
			expect(existsSync(walPath)).toBe(true);
			expect(mock.counts.ctor).toBe(1);
		}));
});

describe("LadybugStore corruption-window hardening (SIO-1236)", () => {
	afterAll(() => _setLbugLoaderForTesting(undefined));

	test("opens the Database with autoCheckpoint on and a 256KB checkpoint threshold", async () =>
		withTempDir(async (dir) => {
			const mock = mockLbug({});
			_setLbugLoaderForTesting(mock.loader);

			const store = new LadybugStore(join(dir, "knowledge-graph"));
			await store.run("MATCH (n) RETURN n");

			expect(mock.ctorArgs.length).toBe(1);
			// Positional lbug ctor: (path, bufferManagerSize, enableCompression,
			// readOnly, maxDBSize, autoCheckpoint, checkpointThreshold). The default
			// threshold is 16MB, which this store's WAL never reaches -- so nothing
			// ever checkpointed and the WAL stayed a permanently-open torn-tail window.
			expect(mock.ctorArgs[0]?.[5]).toBe(true);
			expect(mock.ctorArgs[0]?.[6]).toBe(256 * 1024);
		}));

	test("init() issues a best-effort CHECKPOINT after migrations", async () =>
		withTempDir(async (dir) => {
			const mock = mockLbug({});
			_setLbugLoaderForTesting(mock.loader);

			const store = new LadybugStore(join(dir, "knowledge-graph"));
			await store.init();

			expect(mock.queries).toContain("CHECKPOINT");
		}));

	test("init() still succeeds when CHECKPOINT is unsupported", async () =>
		withTempDir(async (dir) => {
			const mock = mockLbug({
				queryThrows: (cypher) =>
					cypher === "CHECKPOINT" ? new Error("Parser exception: unexpected token") : undefined,
			});
			_setLbugLoaderForTesting(mock.loader);

			const store = new LadybugStore(join(dir, "knowledge-graph"));
			await expect(store.init()).resolves.toBeUndefined();
		}));
});
