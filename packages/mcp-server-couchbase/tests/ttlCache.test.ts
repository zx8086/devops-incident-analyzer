// tests/ttlCache.test.ts

import { describe, expect, test } from "bun:test";
import { TtlCache } from "../src/lib/ttlCache";

describe("TtlCache", () => {
	test("caches within TTL and dedupes concurrent loads", async () => {
		const cache = new TtlCache<number>(1000);
		let loads = 0;
		const load = async () => {
			loads++;
			return 42;
		};
		const [a, b] = await Promise.all([cache.getOrLoad("k", load), cache.getOrLoad("k", load)]);
		expect(a).toBe(42);
		expect(b).toBe(42);
		expect(loads).toBe(1);
		expect(await cache.getOrLoad("k", load)).toBe(42);
		expect(loads).toBe(1);
	});

	test("distinct keys load independently", async () => {
		const cache = new TtlCache<string>(1000);
		expect(await cache.getOrLoad("a", async () => "A")).toBe("A");
		expect(await cache.getOrLoad("b", async () => "B")).toBe("B");
	});

	test("expires after TTL", async () => {
		const cache = new TtlCache<number>(10);
		let loads = 0;
		const load = async () => ++loads;
		expect(await cache.getOrLoad("k", load)).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(await cache.getOrLoad("k", load)).toBe(2);
	});

	test("a load slower than the TTL stays deduplicated while pending", async () => {
		const cache = new TtlCache<number>(10);
		let loads = 0;
		let release: (v: number) => void = () => {};
		const slow = () => {
			loads++;
			return new Promise<number>((resolve) => {
				release = resolve;
			});
		};
		const first = cache.getOrLoad("k", slow);
		// Wait past the TTL while the load is still pending -- must NOT re-trigger.
		await new Promise((resolve) => setTimeout(resolve, 25));
		const second = cache.getOrLoad("k", slow);
		release(9);
		expect(await first).toBe(9);
		expect(await second).toBe(9);
		expect(loads).toBe(1);
	});

	test("failed loads are evicted immediately, not cached for the TTL", async () => {
		const cache = new TtlCache<number>(60_000);
		let calls = 0;
		const flaky = async () => {
			calls++;
			if (calls === 1) throw new Error("boom");
			return 7;
		};
		await expect(cache.getOrLoad("k", flaky)).rejects.toThrow("boom");
		// Eviction happens on the rejection microtask; yield once before retrying.
		await Promise.resolve();
		expect(await cache.getOrLoad("k", flaky)).toBe(7);
	});

	test("invalidate clears a key or everything", async () => {
		const cache = new TtlCache<number>(60_000);
		let loads = 0;
		const load = async () => ++loads;
		await cache.getOrLoad("k", load);
		cache.invalidate("k");
		expect(await cache.getOrLoad("k", load)).toBe(2);
		cache.invalidate();
		expect(await cache.getOrLoad("k", load)).toBe(3);
	});
});
