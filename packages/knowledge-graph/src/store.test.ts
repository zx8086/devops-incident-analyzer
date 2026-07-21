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
} from "./store.ts";

describe("graphPath", () => {
	test("returns the env override verbatim when set", () => {
		expect(graphPath({ KNOWLEDGE_GRAPH_PATH: "/custom/path" } as NodeJS.ProcessEnv)).toBe("/custom/path");
	});

	test("resolves the bare default to an absolute path anchored at the repo root, not cwd", () => {
		const path = graphPath({} as NodeJS.ProcessEnv);
		expect(isAbsolute(path)).toBe(true);
		expect(path.endsWith(".data/knowledge-graph")).toBe(true);
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

	test("quarantines the .wal file and retries once on a corrupt-WAL error", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			let constructCalls = 0;
			_setLbugLoaderForTesting(async () => ({
				Database: class {
					constructor(_dbPath: string) {
						constructCalls += 1;
						if (constructCalls === 1) {
							throw new Error("Runtime exception: Corrupted wal file. Read out invalid WAL record type.");
						}
					}
				} as unknown as new (
					dbPath: string,
				) => import("./store.ts").LbugDatabase,
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
					db: import("./store.ts").LbugDatabase,
				) => never,
			}));

			const store = new LadybugStore(path);
			await store.run("MATCH (n) RETURN n");

			expect(constructCalls).toBe(2);
			expect(existsSync(walPath)).toBe(false);
			const quarantined = readdirSync(dir).filter((f) => f.startsWith("knowledge-graph.wal.corrupt-"));
			expect(quarantined.length).toBe(1);
		}));

	test("rethrows unchanged when the retry also fails", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			writeFileSync(`${path}.wal`, "not a real wal file");

			_setLbugLoaderForTesting(async () => ({
				Database: class {
					constructor(_dbPath: string) {
						throw new Error("Runtime exception: Corrupted wal file. Read out invalid WAL record type.");
					}
				} as unknown as new (
					dbPath: string,
				) => import("./store.ts").LbugDatabase,
				Connection: class {} as unknown as new (db: import("./store.ts").LbugDatabase) => never,
			}));

			const store = new LadybugStore(path);
			await expect(store.run("MATCH (n) RETURN n")).rejects.toThrow(/corrupted wal file/i);
		}));

	test("rethrows a non-WAL error immediately without touching the .wal file", async () =>
		withTempDir(async (dir) => {
			const path = join(dir, "knowledge-graph");
			const walPath = `${path}.wal`;
			writeFileSync(walPath, "not a real wal file");

			let constructCalls = 0;
			_setLbugLoaderForTesting(async () => ({
				Database: class {
					constructor(_dbPath: string) {
						constructCalls += 1;
						throw new Error("IO exception: Could not set lock on file");
					}
				} as unknown as new (
					dbPath: string,
				) => import("./store.ts").LbugDatabase,
				Connection: class {} as unknown as new (db: import("./store.ts").LbugDatabase) => never,
			}));

			const store = new LadybugStore(path);
			await expect(store.run("MATCH (n) RETURN n")).rejects.toThrow(/could not set lock/i);
			expect(constructCalls).toBe(1);
			expect(existsSync(walPath)).toBe(true);
		}));
});
