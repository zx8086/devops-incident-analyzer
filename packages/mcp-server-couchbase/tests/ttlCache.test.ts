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
