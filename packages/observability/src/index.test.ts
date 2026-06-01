// packages/observability/src/index.test.ts
// SIO-864: smoke test so `bun test` finds at least one file (the package had none,
// which made `bun run --filter '*' test` exit 1 and fail the whole CI run). Asserts
// the public surface is importable and the core factories return usable objects.
import { describe, expect, test } from "bun:test";
import { getChildLogger, getLogger, getTracer, runWithRequestContext, SpanKind } from "./index.ts";

describe("observability public surface", () => {
	test("getLogger returns a logger with the standard pino methods", () => {
		const logger = getLogger("test");
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.warn).toBe("function");
		expect(typeof logger.error).toBe("function");
	});

	test("getChildLogger derives a child logger from a parent", () => {
		const child = getChildLogger(getLogger("test"), "smoke");
		expect(typeof child.info).toBe("function");
	});

	test("getTracer returns a tracer that can start a span", () => {
		const tracer = getTracer("test");
		expect(typeof tracer.startSpan).toBe("function");
	});

	test("SpanKind enum is exported", () => {
		expect(SpanKind.INTERNAL).toBeDefined();
	});

	test("runWithRequestContext runs the callback and returns its value", () => {
		const result = runWithRequestContext({ threadId: "t", runId: "r", requestId: "smoke" }, () => 42);
		expect(result).toBe(42);
	});
});
