// knowledge-graph/src/store.test.ts
//
// SIO-1163: covers the corrupt-WAL recurrence of SIO-1129 -- the getGraphStore()
// singleton must not permanently latch onto a rejected promise, and graphPath()
// must resolve to an absolute path so "which .data did this process open" can't
// recur. Real-engine WAL corruption is impractical to reproduce here (would
// require a genuinely corrupt native WAL); that control flow is covered via
// LadybugStore's error-classification behavior instead.

import { afterAll, describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { _setGraphStoreFactoryForTesting, getGraphStore, graphPath, InMemoryGraphStore } from "./store.ts";

describe("graphPath", () => {
	test("returns the env override verbatim when set", () => {
		expect(graphPath({ KNOWLEDGE_GRAPH_PATH: "/custom/path" } as NodeJS.ProcessEnv)).toBe("/custom/path");
	});

	test("resolves the bare default to an absolute path", () => {
		const path = graphPath({} as NodeJS.ProcessEnv);
		expect(isAbsolute(path)).toBe(true);
		expect(path.endsWith(".data/knowledge-graph")).toBe(true);
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
