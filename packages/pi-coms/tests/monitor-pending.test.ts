// tests/monitor-pending.test.ts
import { describe, expect, test } from "bun:test";
import { PendingReplies } from "../scripts/monitor/pending.ts";

describe("PendingReplies", () => {
	test("a reply that arrives before register() is adopted, not dropped", async () => {
		const p = new PendingReplies();
		expect(p.resolve("m1", { error: "recipient muted (monitor-*)" })).toBe(false);
		expect(p.earlySize()).toBe(1);
		p.register("m1");
		expect(p.earlySize()).toBe(0);
		const r = await p.await("m1", 10_000);
		expect(r.error).toBe("recipient muted (monitor-*)");
		expect(p.size()).toBe(0);
	});

	test("normal order: register, resolve, await", async () => {
		const p = new PendingReplies();
		p.register("m2");
		expect(p.resolve("m2", { response: { diagnoses: [] } })).toBe(true);
		const r = await p.await("m2", 10_000);
		expect(r.response).toEqual({ diagnoses: [] });
	});

	test("await resolves as soon as the reply lands", async () => {
		const p = new PendingReplies();
		p.register("m3");
		const waiting = p.await("m3", 10_000);
		setTimeout(() => p.resolve("m3", { response: "late" }), 20);
		expect((await waiting).response).toBe("late");
	});

	test("unknown or silent ids time out and never leak an entry", async () => {
		const p = new PendingReplies();
		p.register("m4");
		expect((await p.await("m4", 20)).error).toBe("timeout");
		expect((await p.await("never-registered", 20)).error).toBe("timeout");
		expect(p.size()).toBe(0);
	});

	test("both maps are bounded, oldest first", () => {
		const p = new PendingReplies(2);
		p.register("a");
		p.register("b");
		p.register("c");
		expect(p.size()).toBe(2);
		p.resolve("x", {});
		p.resolve("y", {});
		p.resolve("z", {});
		expect(p.earlySize()).toBe(2);
		p.register("x");
		// x was evicted as the oldest early reply, so nothing is adopted.
		expect(p.earlySize()).toBe(2);
	});

	test("a reply for an ignored id (fire-and-forget) or a finished await is dropped, not parked", async () => {
		const p = new PendingReplies();
		p.ignore("report-1");
		expect(p.resolve("report-1", { response: "ack" })).toBe(false);
		expect(p.earlySize()).toBe(0);
		p.register("m5");
		expect((await p.await("m5", 20)).error).toBe("timeout");
		expect(p.resolve("m5", { response: "late" })).toBe(false);
		expect(p.earlySize()).toBe(0);
	});

	test("await clears its timer so an early reply does not hold the process for the budget", async () => {
		const p = new PendingReplies();
		p.register("m6");
		const started = Date.now();
		const waiting = p.await("m6", 60_000);
		p.resolve("m6", { response: "fast" });
		expect((await waiting).response).toBe("fast");
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
