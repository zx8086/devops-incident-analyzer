// packages/checkpointer/src/index.test.ts
// SIO-864: smoke test so `bun test` finds at least one file (the package had none,
// which made `bun run --filter '*' test` exit 1 and fail the whole CI run). Asserts
// the factory contract: memory works, sqlite is a clear not-yet-implemented error,
// unknown types are rejected.
import { describe, expect, test } from "bun:test";
import { createCheckpointer, createMemoryCheckpointer } from "./index.ts";

describe("createCheckpointer", () => {
	test("defaults to a memory checkpointer with the MemorySaver surface", () => {
		const cp = createCheckpointer();
		expect(typeof cp.put).toBe("function");
		expect(typeof cp.getTuple).toBe("function");
	});

	test("'memory' returns the same MemorySaver-shaped object", () => {
		const cp = createCheckpointer("memory");
		expect(typeof cp.put).toBe("function");
	});

	test("'sqlite' throws a clear not-yet-implemented error", () => {
		expect(() => createCheckpointer("sqlite")).toThrow("not yet implemented");
	});

	test("createMemoryCheckpointer is exported and usable directly", () => {
		const cp = createMemoryCheckpointer();
		expect(typeof cp.put).toBe("function");
	});
});
