// shared/src/__tests__/request-context.test.ts
import { describe, expect, test } from "bun:test";
import { getCurrentRequestContext, runWithRequestContext } from "../request-context.ts";

describe("RequestContext", () => {
	test("returns undefined outside runWithRequestContext", () => {
		expect(getCurrentRequestContext()).toBeUndefined();
	});

	test("returns the same context object inside the run", async () => {
		const ctx = { threadId: "t1", runId: "r1", requestId: "q1" };
		await runWithRequestContext(ctx, async () => {
			expect(getCurrentRequestContext()).toEqual(ctx);
		});
	});

	test("context survives an await", async () => {
		const ctx = { threadId: "t1", runId: "r1", requestId: "q1" };
		await runWithRequestContext(ctx, async () => {
			await Promise.resolve();
			expect(getCurrentRequestContext()).toEqual(ctx);
		});
	});

	test("nested run shadows outer context", async () => {
		const outer = { threadId: "outer-t", runId: "outer-r", requestId: "outer-q" };
		const inner = { threadId: "inner-t", runId: "inner-r", requestId: "inner-q" };
		await runWithRequestContext(outer, async () => {
			await runWithRequestContext(inner, async () => {
				expect(getCurrentRequestContext()).toEqual(inner);
			});
			expect(getCurrentRequestContext()).toEqual(outer);
		});
		expect(getCurrentRequestContext()).toBeUndefined();
	});

	test("context returned from fn is propagated as the value", async () => {
		const ctx = { threadId: "t1", runId: "r1", requestId: "q1" };
		const result = await runWithRequestContext(ctx, async () => "done");
		expect(result).toBe("done");
	});
});
