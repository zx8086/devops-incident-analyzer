// src/lib/ttlCache.ts

// Minimal keyed TTL memoizer for slow-changing catalog lookups (bucket topology,
// scopes/collections). Deduplicates in-flight calls: concurrent requests for the
// same key share one promise instead of each hitting the cluster. Failed loads
// are evicted immediately so an error never gets cached for the TTL window.
export class TtlCache<T> {
	private readonly entries = new Map<string, { value: Promise<T>; expiresAt: number }>();

	constructor(private readonly ttlMs: number) {}

	getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
		const hit = this.entries.get(key);
		if (hit && hit.expiresAt > Date.now()) {
			return hit.value;
		}
		const value = load();
		// The TTL countdown starts when the load SETTLES, not when it starts:
		// Infinity while pending keeps a slow load deduplicated instead of being
		// treated as expired and re-triggered by the next caller.
		const entry = { value, expiresAt: Number.POSITIVE_INFINITY };
		this.entries.set(key, entry);
		value.then(
			() => {
				entry.expiresAt = Date.now() + this.ttlMs;
			},
			() => {
				// Only evict if this exact promise is still the cached one.
				if (this.entries.get(key) === entry) {
					this.entries.delete(key);
				}
			},
		);
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
