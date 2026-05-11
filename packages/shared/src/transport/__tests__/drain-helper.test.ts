// shared/src/transport/__tests__/drain-helper.test.ts
//
// SIO-727: drainBunServer races server.stop() against a bounded deadline and
// always returns (never rejects). Tests assert the three core outcomes:
// graceful drain, deadline force-close, and error-swallowing semantics.

import { describe, expect, mock, test } from "bun:test";
import type { BootstrapLogger } from "../../bootstrap.ts";
import { drainBunServer } from "../drain-helper.ts";

function makeLogger(): BootstrapLogger & {
	infoSpy: ReturnType<typeof mock>;
	warnSpy: ReturnType<typeof mock>;
	errorSpy: ReturnType<typeof mock>;
} {
	const info = mock(() => {});
	const warn = mock(() => {});
	const error = mock(() => {});
	return {
		info: info as unknown as BootstrapLogger["info"],
		warn: warn as unknown as BootstrapLogger["warn"],
		error: error as unknown as BootstrapLogger["error"],
		infoSpy: info,
		warnSpy: warn,
		errorSpy: error,
	};
}

describe("drainBunServer", () => {
	test("resolves immediately when stop() resolves quickly (graceful path)", async () => {
		const stop = mock(async (_force?: boolean) => {});
		const server = { stop };
		const logger = makeLogger();

		const started = Date.now();
		await drainBunServer(server, 5000, logger);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(200); // well under deadline
		expect(stop).toHaveBeenCalledTimes(1);
		expect(stop.mock.calls[0]?.[0]).toBeUndefined(); // stop() called with no arg = drain mode
		expect(logger.infoSpy).toHaveBeenCalledTimes(1);
		expect(logger.warnSpy).not.toHaveBeenCalled();
		expect(logger.errorSpy).not.toHaveBeenCalled();
	});

	test("force-closes via stop(true) when graceful drain exceeds deadline", async () => {
		let stopCalls = 0;
		const stop = mock(async (force?: boolean) => {
			stopCalls += 1;
			if (force) return; // force-close returns instantly
			// graceful stop hangs forever (simulates an unresponsive connection)
			await new Promise(() => {});
		});
		const server = { stop };
		const logger = makeLogger();

		const started = Date.now();
		await drainBunServer(server, 100, logger);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(95); // hit the deadline
		expect(elapsed).toBeLessThan(500); // didn't hang
		expect(stopCalls).toBe(2); // graceful attempt, then force
		expect(stop.mock.calls[1]?.[0]).toBe(true); // second call forced
		expect(logger.warnSpy).toHaveBeenCalledTimes(1);
		const warnArgs = logger.warnSpy.mock.calls[0] as [string, Record<string, unknown>];
		expect(warnArgs[0]).toContain("exceeded deadline");
		expect(warnArgs[1].deadlineMs).toBe(100);
	});

	test("deadlineMs=0 skips the drain and force-closes immediately", async () => {
		const stop = mock(async (_force?: boolean) => {});
		const server = { stop };
		const logger = makeLogger();

		await drainBunServer(server, 0, logger);

		expect(stop).toHaveBeenCalledTimes(1);
		expect(stop.mock.calls[0]?.[0]).toBe(true); // immediate force-close
		expect(logger.infoSpy).not.toHaveBeenCalled();
		expect(logger.warnSpy).not.toHaveBeenCalled();
	});

	test("graceful drain rejection triggers force-close fallback", async () => {
		let calls = 0;
		const stop = mock(async (force?: boolean) => {
			calls += 1;
			if (!force) throw new Error("graceful stop failed");
			// force-close resolves cleanly
		});
		const server = { stop };
		const logger = makeLogger();

		await drainBunServer(server, 5000, logger);

		expect(calls).toBe(2);
		expect(stop.mock.calls[1]?.[0]).toBe(true);
		expect(logger.errorSpy).toHaveBeenCalledTimes(1);
		const errArgs = logger.errorSpy.mock.calls[0] as [string, Record<string, unknown>];
		expect(errArgs[0]).toContain("Graceful drain rejected");
	});

	test("force-close rejection after timeout is swallowed (never throws)", async () => {
		let calls = 0;
		const stop = mock(async (force?: boolean) => {
			calls += 1;
			if (!force) await new Promise(() => {}); // hang to trigger timeout
			throw new Error("force stop also failed");
		});
		const server = { stop };
		const logger = makeLogger();

		// Must not throw. If drainBunServer threw, the test runner would catch
		// an unhandled rejection and fail.
		await drainBunServer(server, 50, logger);

		expect(calls).toBe(2);
		expect(logger.warnSpy).toHaveBeenCalledTimes(1); // deadline warn
		expect(logger.errorSpy).toHaveBeenCalledTimes(1); // force-close error
	});

	test("force-close rejection after graceful failure is also swallowed", async () => {
		const stop = mock(async (_force?: boolean) => {
			throw new Error("everything fails");
		});
		const server = { stop };
		const logger = makeLogger();

		await drainBunServer(server, 5000, logger);

		// Both graceful and force attempts threw; both got logged at error level.
		expect(logger.errorSpy.mock.calls.length).toBe(2);
	});

	test("graceful drain succeeds even when slightly under deadline (no race condition)", async () => {
		// Drain takes 80ms, deadline 200ms -- should clearly resolve gracefully.
		const stop = mock(async (force?: boolean) => {
			if (!force) await new Promise((r) => setTimeout(r, 80));
		});
		const server = { stop };
		const logger = makeLogger();

		await drainBunServer(server, 200, logger);

		expect(stop).toHaveBeenCalledTimes(1);
		expect(logger.infoSpy).toHaveBeenCalledTimes(1);
		expect(logger.warnSpy).not.toHaveBeenCalled();
	});

	test("logs elapsedMs on the graceful path", async () => {
		const stop = mock(async (_force?: boolean) => {
			await new Promise((r) => setTimeout(r, 30));
		});
		const server = { stop };
		const logger = makeLogger();

		await drainBunServer(server, 5000, logger);

		const infoArgs = logger.infoSpy.mock.calls[0] as [string, Record<string, unknown>];
		expect(typeof infoArgs[1].elapsedMs).toBe("number");
		expect(infoArgs[1].elapsedMs as number).toBeGreaterThanOrEqual(25);
		expect(infoArgs[1].elapsedMs as number).toBeLessThan(500);
	});
});
