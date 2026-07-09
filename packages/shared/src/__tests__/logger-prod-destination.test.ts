// shared/src/__tests__/logger-prod-destination.test.ts
// SIO-1041: prod/staging branch uses an ASYNC SonicBoom destination (sync:false). A buffered line
// must still land: flushSync() (the exit hook's mechanism) forces it out synchronously.
import { describe, expect, test } from "bun:test";
import { openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { buildEcsOptions, createProdDestination } from "../logger.ts";

function tmpPath(): string {
	return join(tmpdir(), `sio-1041-log-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
}

describe("createProdDestination (prod/staging async branch)", () => {
	test("a logged line is buffered async but landed by flushSync", () => {
		const path = tmpPath();
		const fd = openSync(path, "w");
		try {
			// createProdDestination targets fd 1|2 in production; point it at a temp fd here so the
			// test can read back exactly what landed. The SonicBoom itself is returned so flushSync
			// hits it directly (not any wrapper).
			const sonic = createProdDestination(fd as 1 | 2);
			const ecsOpts = buildEcsOptions({ serviceName: "prod-test", serviceEnvironment: "production" });
			const logger = pino({ level: "info", ...ecsOpts }, sonic as unknown as pino.DestinationStream).child({
				service: "prod-test",
			});

			logger.info({ probe: "sio-1041" }, "async destination line");

			// Async destination: the line is buffered below minLength (4096), so it is NOT on disk yet.
			// flushSync -- the exact mechanism the process 'exit' hook uses -- forces it out.
			sonic.flushSync();

			const contents = readFileSync(path, "utf8");
			expect(contents).toContain("async destination line");
			expect(contents).toContain("sio-1041");
			const entry = JSON.parse(contents.trim().split("\n")[0] ?? "{}") as Record<string, unknown>;
			expect(entry.message).toBe("async destination line");
			expect(entry["service.environment"]).toBe("production");
		} finally {
			try {
				unlinkSync(path);
			} catch {
				// best-effort cleanup
			}
		}
	});
});
