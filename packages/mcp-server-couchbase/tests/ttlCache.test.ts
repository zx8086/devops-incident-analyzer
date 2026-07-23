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
		let releaseFirst: ((v: number) => void) | undefined;
		const slow = () => {
			loads++;
			return new Promise<number>((resolve) => {
				// Retain only the FIRST resolver: if a duplicate load starts, the test
				// must fail on the loads assertion below, not hang on an unresolved first.
				if (loads === 1) {
					releaseFirst = resolve;
				}
			});
		};
		const first = cache.getOrLoad("k", slow);
		// Wait past the TTL while the load is still pending -- must NOT re-trigger.
		await new Promise((resolve) => setTimeout(resolve, 25));
		const second = cache.getOrLoad("k", slow);
		expect(loads).toBe(1);
		if (!releaseFirst) throw new Error("first load was not started");
		releaseFirst(9);
		expect(await first).toBe(9);
		expect(await second).toBe(9);
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
		await cache.getOrLoad("other", load);
		// Targeted invalidation reloads only "k"; "other" stays cached.
		cache.invalidate("k");
		expect(await cache.getOrLoad("k", load)).toBe(3);
		expect(await cache.getOrLoad("other", load)).toBe(2);
		// Global invalidation reloads BOTH keys.
		cache.invalidate();
		expect(await cache.getOrLoad("k", load)).toBe(4);
		expect(await cache.getOrLoad("other", load)).toBe(5);
	});
});
