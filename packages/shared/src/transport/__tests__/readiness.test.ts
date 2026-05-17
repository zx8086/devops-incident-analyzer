// packages/shared/src/transport/__tests__/readiness.test.ts
import { describe, expect, test } from "bun:test";
import { createReadinessProbe } from "../readiness.ts";

describe("createReadinessProbe", () => {
	test("all probes succeed -> ready: true", async () => {
		const probe = createReadinessProbe({
			components: {
				a: async () => {},
				b: async () => {},
			},
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components).toEqual({ a: "ok", b: "ok" });
	});

	test("one probe fails -> ready: false + per-component error", async () => {
		const probe = createReadinessProbe({
			components: {
				a: async () => {},
				b: async () => {
					throw new Error("boom");
				},
			},
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components).toEqual({ a: "ok", b: "unreachable" });
		expect(snap.errors).toEqual({ b: "boom" });
	});

	test("null/undefined probe -> disabled", async () => {
		const probe = createReadinessProbe({
			components: {
				a: async () => {},
				disabledService: null,
			},
		});
		const snap = await probe();
		expect(snap.components.disabledService).toBe("disabled");
		expect(snap.ready).toBe(true);
	});

	test("TTL cache returns the same snapshot within window", async () => {
		let calls = 0;
		const probe = createReadinessProbe({
			components: {
				a: async () => {
					calls++;
				},
			},
			ttlMs: 1_000,
		});
		await probe();
		await probe();
		await probe();
		expect(calls).toBe(1);
	});

	test("TTL expires -> new probe call runs", async () => {
		let calls = 0;
		let clock = 0;
		const probe = createReadinessProbe({
			components: {
				a: async () => {
					calls++;
				},
			},
			ttlMs: 100,
			now: () => clock,
		});
		await probe();
		clock = 200;
		await probe();
		expect(calls).toBe(2);
	});

	test("single-flight: concurrent calls share one in-flight probe", async () => {
		let calls = 0;
		let resolveProbe: (() => void) | undefined;
		const probe = createReadinessProbe({
			components: {
				a: () =>
					new Promise<void>((resolve) => {
						calls++;
						resolveProbe = resolve;
					}),
			},
		});
		const p1 = probe();
		const p2 = probe();
		const p3 = probe();
		expect(calls).toBe(1);
		resolveProbe?.();
		await Promise.all([p1, p2, p3]);
		expect(calls).toBe(1);
	});

	test("probe times out per timeoutMs", async () => {
		const probe = createReadinessProbe({
			components: {
				slow: () => new Promise(() => {}), // never resolves
			},
			timeoutMs: 50,
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.slow).toBe("unreachable");
		expect(snap.errors?.slow).toContain("timed out");
	});
});
