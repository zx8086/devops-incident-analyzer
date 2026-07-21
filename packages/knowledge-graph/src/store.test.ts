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

// Builds a fake lbug module whose Database constructor throws when throwOnCall(n)
// returns an Error for the nth construction attempt (1-indexed), and otherwise
// succeeds with a Connection that answers empty result sets.
function mockLbugLoader(throwOnCall: (call: number) => Error | undefined): () => Promise<LbugModule> {
	let calls = 0;
	return async () => ({
		Database: class {
			constructor(_dbPath: string) {
				calls += 1;
				const err = throwOnCall(calls);
				if (err) throw err;
			}
		} as unknown as new (
			dbPath: string,
		) => LbugDatabase,
		Connection: class {
			async query() {
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
	});
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

	async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
		const dir = mkdtempSync(join(tmpdir(), "kg-store-test-"));
		try {
			await fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	const CORRUPT_WAL_ERROR = "Runtime exception: Corrupted wal file. Read out invalid WAL record type.";

	test("quarantines the .wal file and retries once on a corrupt-WAL error", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			_setLbugLoaderForTesting(mockLbugLoader((call) => (call === 1 ? new Error(CORRUPT_WAL_ERROR) : undefined)));

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

			_setLbugLoaderForTesting(mockLbugLoader(() => new Error(CORRUPT_WAL_ERROR)));

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

			let constructCalls = 0;
			_setLbugLoaderForTesting(
				mockLbugLoader((call) => {
					constructCalls = call;
					return new Error("IO exception: Could not set lock on file");
				}),
			);

			const store = new LadybugStore(path);
			await expect(store.run("MATCH (n) RETURN n")).rejects.toThrow(/could not set lock/i);
			expect(constructCalls).toBe(1);
			expect(existsSync(walPath)).toBe(true);
		}));
});
