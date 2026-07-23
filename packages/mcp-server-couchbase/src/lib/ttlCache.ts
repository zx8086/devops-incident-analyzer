// src/lib/ttlCache.ts

// Minimal keyed TTL memoizer for slow-changing catalog lookups (bucket topology,
// scopes/collections). Deduplicates in-flight calls: concurrent requests for the
// same key share one promise instead of each hitting the cluster. Failed loads
// are evicted immediately so an error never gets cached for the TTL window.
export class TtlCache<T> {
	private readonly entries = new Map<string, { value: Promise<T>; expiresAt: number }>();

	constructor(private readonly ttlMs: number) {}

	getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
		const now = Date.now();
		const hit = this.entries.get(key);
		if (hit && hit.expiresAt > now) {
			return hit.value;
		}
		const value = load();
		this.entries.set(key, { value, expiresAt: now + this.ttlMs });
		value.catch(() => {
			// Only evict if this exact promise is still the cached one.
			const current = this.entries.get(key);
			if (current?.value === value) {
				this.entries.delete(key);
			}
		});
		return value;
	}

	invalidate(key?: string): void {
		if (key === undefined) {
			this.entries.clear();
		} else {
			this.entries.delete(key);
		}
	}
}
