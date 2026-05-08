// agent/tests/graph-correlation.test.ts
import { describe, expect, test } from "bun:test";
import { buildGraph } from "../src/graph.ts";

describe("graph wiring — enforceCorrelations", () => {
	test("graph builds without error", async () => {
		const built = await buildGraph();
		expect(built).toBeDefined();
	});

	test("graph has invoke (smoke: new correlation nodes registered without runtime error)", async () => {
		const graph = await buildGraph();
		expect(typeof graph.invoke).toBe("function");
	});
});
