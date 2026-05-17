// shared/src/__tests__/request-context.test.ts
import { describe, expect, test } from "bun:test";
import pino from "pino";
import { buildEcsOptions } from "../logger.ts";
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

describe("RequestContext + pino mixin", () => {
	function captureLogs() {
		const records: Array<Record<string, unknown>> = [];
		const dest = {
			write(data: string) {
				records.push(JSON.parse(data));
			},
		};
		const opts = buildEcsOptions({ serviceName: "test" });
		const logger = pino({ level: "info", ...opts }, dest).child({ service: "test" });
		return { logger, records };
	}

	test("logs inside runWithRequestContext include threadId/runId/requestId", async () => {
		const { logger, records } = captureLogs();
		await runWithRequestContext({ threadId: "t-1", runId: "r-1", requestId: "q-1" }, async () => {
			logger.info("inside");
		});
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ threadId: "t-1", runId: "r-1", requestId: "q-1" });
	});

	test("logs outside the run do NOT include those fields", () => {
		const { logger, records } = captureLogs();
		logger.info("outside");
		expect(records).toHaveLength(1);
		const record = records[0] as Record<string, unknown>;
		expect(record.threadId).toBeUndefined();
		expect(record.runId).toBeUndefined();
		expect(record.requestId).toBeUndefined();
	});
});
