/* tests/unit/tracing-initialization-fix-simple.test.ts */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

// SIO-1045: this test previously read an ABSOLUTE path into a pre-monorepo sibling
// repo (/Users/.../WebstormProjects/mcp-server-elasticsearch/src/...) that only
// existed on one machine, so it ENOENT'd on every CI runner. Repointed at the
// in-repo files via import.meta.dir-relative paths. SIO-1043 also turned
// utils/tracing.ts into a thin shim over the shared tracing factory
// (packages/shared/src/tracing/server-tracing-factory.ts -> langsmith.ts), so the
// assertions below target the CURRENT location of the guard/init logic rather than
// the pre-shim shape.
const tracingSourcePath = join(import.meta.dir, "../../src/utils/tracing.ts");
const serverSourcePath = join(import.meta.dir, "../../src/server.ts");
const indexSourcePath = join(import.meta.dir, "../../src/index.ts");
const sharedTracingCorePath = join(import.meta.dir, "../../../shared/src/tracing/langsmith.ts");

describe("Tracing Initialization Fix - Integration Test", () => {
	it("should verify initialization guard exists in the shared tracing core", async () => {
		// SIO-1043 moved the isInitialized guard out of the per-server tracing.ts
		// shim into the shared factory's core (packages/shared/src/tracing/langsmith.ts),
		// which every mcp-server's initializeTracing() now delegates to.
		const sharedTracingSource = await Bun.file(sharedTracingCorePath).text();

		expect(sharedTracingSource).toContain("let isInitialized = false");
		expect(sharedTracingSource).toContain("if (isInitialized) return");
		expect(sharedTracingSource).toContain("isInitialized = true");
	});

	it("should verify the elastic tracing shim delegates to the shared factory instead of reimplementing init", async () => {
		const tracingSource = await Bun.file(tracingSourcePath).text();

		// The shim no longer owns the guard itself -- it wires elastic-specific
		// config (dataSourceId/project env var/logger) into createServerTracing()
		// and re-exports the resulting initializeTracing/traceToolCall pair.
		expect(tracingSource).toContain("createServerTracing");
		expect(tracingSource).toContain("export { initializeTracing, traceToolCall }");
		// No local isInitialized guard duplicated in the shim (it lives upstream now).
		expect(tracingSource).not.toContain("isInitialized");
	});

	it("should verify server.ts has no tracing initialization call", async () => {
		const serverSource = await Bun.file(serverSourcePath).text();

		// server.ts never imports or calls initializeTracing -- initialization is
		// index.ts's responsibility exclusively.
		expect(serverSource).not.toContain("initializeTracing");
	});

	it("should verify index.ts has exactly one initialization call, wired through createMcpApplication", async () => {
		const indexSource = await Bun.file(indexSourcePath).text();

		const initializeCalls = (indexSource.match(/initializeTracing\(\)/g) || []).length;
		expect(initializeCalls).toBe(1);

		// Initialization now happens via the initTracing bootstrap hook rather than a
		// bare top-level statement.
		expect(indexSource).toContain("initTracing: () => initializeTracing()");
	});
});
