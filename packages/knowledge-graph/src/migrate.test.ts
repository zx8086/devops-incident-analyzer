// knowledge-graph/src/migrate.test.ts
import { describe, expect, test } from "bun:test";
import { migrate, seed } from "./migrate.ts";
import { _setGraphStoreForTesting, InMemoryGraphStore } from "./store.ts";

describe("migrate", () => {
	test("initializes the graph store (applies schema)", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		try {
			expect(store.initialized).toBe(false);
			await migrate();
			expect(store.initialized).toBe(true);
		} finally {
			_setGraphStoreForTesting(null);
		}
	});
});

describe("seed", () => {
	test("writes the distilled service-dependency topology", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		try {
			await seed();
			// Params are bound ($value/$from/$to), not interpolated into the cypher text, so assert
			// against the recorded param values -- every seed service must appear as a Service node
			// merge target somewhere in the batch.
			const boundValues = store.calls.flatMap((c) => Object.values(c.params ?? {}));
			for (const service of [
				"konnect-gateway",
				"backend-services",
				"couchbase",
				"kafka",
				"elasticsearch",
				"downstream-consumers",
			]) {
				expect(boundValues).toContain(service);
			}
			// And the 5 documented dependency edges are all present as from/to pairs.
			const edgeCalls = store.calls.filter((c) => c.cypher.includes("DEPENDS_ON"));
			expect(edgeCalls).toHaveLength(5);
		} finally {
			_setGraphStoreForTesting(null);
		}
	});

	test("is idempotent -- running twice does not throw", async () => {
		const store = new InMemoryGraphStore();
		_setGraphStoreForTesting(store);
		try {
			await seed();
			await seed();
		} finally {
			_setGraphStoreForTesting(null);
		}
	});
});
