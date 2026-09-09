// scripts/monitor/pending.ts

export type ReplyResult = { response?: unknown; error?: string | null };

type Entry = {
	promise: Promise<ReplyResult>;
	resolve: (v: ReplyResult) => void;
	result?: ReplyResult;
};

// Reply bookkeeping for sends that expect an answer. The hub streams a prompt
// to the target BEFORE it answers the sender's POST, so a target that replies
// instantly (a refusal, a cached answer) can race the sender's own send()
// call: the response frame arrives before the pending entry exists. Those
// early replies are parked and adopted by register(), otherwise awaitReply
// would sit out its whole budget on a reply that already came (SIO-1673).
export class PendingReplies {
	private pending = new Map<string, Entry>();
	private early = new Map<string, ReplyResult>();
	// Ids whose reply nobody will consume: fire-and-forget sends and awaits
	// that already returned. Their frames are dropped instead of parked, so
	// `early` holds only replies that genuinely beat register().
	private ignored = new Set<string>();
	private cap: number;

	constructor(cap = 200) {
		this.cap = cap;
	}

	register(msgId: string): void {
		let resolve!: (v: ReplyResult) => void;
		const promise = new Promise<ReplyResult>((res) => {
			resolve = res;
		});
		const entry: Entry = { promise, resolve };
		const parked = this.early.get(msgId);
		if (parked) {
			this.early.delete(msgId);
			entry.result = parked;
			resolve(parked);
		}
		this.pending.set(msgId, entry);
		this.evict(this.pending);
	}

	ignore(msgId: string): void {
		this.ignored.add(msgId);
		this.evictSet(this.ignored);
	}

	// true when a registered entry consumed the reply; false when it was
	// parked or dropped.
	resolve(msgId: string, result: ReplyResult): boolean {
		const entry = this.pending.get(msgId);
		if (entry) {
			entry.result = result;
			entry.resolve(result);
			return true;
		}
		if (this.ignored.has(msgId)) return false;
		this.early.set(msgId, result);
		this.evict(this.early);
		return false;
	}

	async await(msgId: string, timeoutMs: number): Promise<ReplyResult> {
		const entry = this.pending.get(msgId);
		try {
			if (entry?.result) return entry.result;
			const local = entry ? entry.promise : new Promise<never>(() => {});
			// A plain timer, cleared on the way out: a Bun.sleep race would keep
			// the process alive for the whole budget (up to 30 min) after an
			// early reply.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<ReplyResult>((res) => {
				timer = setTimeout(() => res({ error: "timeout" }), timeoutMs);
			});
			try {
				return await Promise.race([local, timeout]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		} finally {
			this.pending.delete(msgId);
			this.ignore(msgId);
		}
	}

	size(): number {
		return this.pending.size;
	}

	earlySize(): number {
		return this.early.size;
	}

	private evict(map: Map<string, unknown>): void {
		while (map.size > this.cap) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) break;
			map.delete(oldest);
		}
	}

	private evictSet(set: Set<string>): void {
		while (set.size > this.cap) {
			const oldest = set.values().next().value;
			if (oldest === undefined) break;
			set.delete(oldest);
		}
	}
}
