// packages/shared/src/transport/readiness.ts
// SIO-780: hoisted from packages/mcp-server-kafka/src/transport/readiness.ts (SIO-726).
// Generalized: callers pass a `components` map of probe functions instead of the
// kafka-specific clientManager/toolOptions/config shape. TTL + single-flight
// guard preserved.

export type ComponentStatus = "ok" | "unreachable" | "disabled";

export interface ReadinessSnapshot {
	ready: boolean;
	components: Record<string, ComponentStatus>;
	errors?: Record<string, string>;
	cachedAt: string;
}

export interface CreateReadinessProbeOptions {
	// Probe functions per component. Each must resolve on success and reject on
	// failure. Pass `null` to record a component as `disabled` (e.g. an opt-in
	// service that isn't enabled in this deployment).
	components: Record<string, (() => Promise<void>) | null>;
	ttlMs?: number;
	timeoutMs?: number;
	now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createReadinessProbe(opts: CreateReadinessProbeOptions): () => Promise<ReadinessSnapshot> {
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = opts.now ?? Date.now;

	let cached: { snapshot: ReadinessSnapshot; expiresAt: number } | null = null;
	let inflight: Promise<ReadinessSnapshot> | null = null;

	async function runProbe(): Promise<ReadinessSnapshot> {
		const startedAt = now();
		const componentNames = Object.keys(opts.components);
		const probes = componentNames.map((name) => {
			const fn = opts.components[name];
			if (fn === null || fn === undefined) {
				return { name, enabled: false, promise: Promise.resolve() };
			}
			return { name, enabled: true, promise: withTimeout(fn(), timeoutMs, `${name} probe`) };
		});

		const results = await Promise.allSettled(probes.map((p) => p.promise));

		const components: Record<string, ComponentStatus> = {};
		const errors: Record<string, string> = {};
		let ready = true;

		for (const [i, probe] of probes.entries()) {
			const result = results[i];
			if (!probe.enabled) {
				components[probe.name] = "disabled";
				continue;
			}
			if (result?.status === "fulfilled") {
				components[probe.name] = "ok";
				continue;
			}
			components[probe.name] = "unreachable";
			ready = false;
			if (result?.status === "rejected") {
				errors[probe.name] = errorMessage(result.reason);
			}
		}

		const snapshot: ReadinessSnapshot = { ready, components, cachedAt: new Date(startedAt).toISOString() };
		if (Object.keys(errors).length > 0) snapshot.errors = errors;
		return snapshot;
	}

	return async () => {
		const ts = now();
		if (cached && cached.expiresAt > ts) return cached.snapshot;
		if (inflight) return inflight;
		inflight = runProbe().finally(() => {
			inflight = null;
		});
		const snapshot = await inflight;
		cached = { snapshot, expiresAt: now() + ttlMs };
		return snapshot;
	};
}
