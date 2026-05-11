// src/transport/readiness.ts
//
// SIO-726: readiness probe for the kafka MCP. /ready calls this; the result
// drives 503 vs 200. Probes enabled upstreams only (REST Proxy / Schema
// Registry / Kafka Connect / ksqlDB via their probeReachability methods, plus
// the kafka broker via clientManager.withAdmin(a => a.metadata({}))). Result
// is single-value TTL-cached so k8s/AgentCore liveness loops don't fan out to
// upstreams on every request.

import type { AppConfig } from "../config/schemas.ts";
import type { KafkaClientManager } from "../services/client-manager.ts";
import type { ToolRegistrationOptions } from "../tools/index.ts";

export type ComponentName = "kafka" | "schemaRegistry" | "ksql" | "connect" | "restproxy";
export type ComponentStatus = "ok" | "unreachable" | "disabled";

export interface ReadinessSnapshot {
	ready: boolean;
	components: Record<ComponentName, ComponentStatus>;
	errors?: Partial<Record<ComponentName, string>>;
	cachedAt: string;
}

export interface CreateReadinessProbeOptions {
	clientManager: KafkaClientManager;
	toolOptions: ToolRegistrationOptions;
	config: AppConfig;
	// Cache TTL. Default 30s per SIO-726 spec; tunable for tests.
	ttlMs?: number;
	// Per-probe timeout. Default 5s -- matches the service probeReachability
	// internals. Wraps the kafka admin probe too, which has no native timeout.
	timeoutMs?: number;
	// Time source. Injected for deterministic cache tests.
	now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

// Wrap a promise in a deadline. Used for the kafka admin probe which has no
// native AbortSignal -- a sleepy MSK could otherwise stall /ready for the full
// admin retry budget.
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

// Build the snapshot from raw probe results. Pure -- no I/O, no clock reads
// besides the cachedAt stamp passed in.
function buildSnapshot(
	probeOutcomes: Record<ComponentName, { enabled: boolean; result: PromiseSettledResult<void> | null }>,
	cachedAt: string,
): ReadinessSnapshot {
	const components = {} as Record<ComponentName, ComponentStatus>;
	const errors: Partial<Record<ComponentName, string>> = {};
	let ready = true;

	for (const name of Object.keys(probeOutcomes) as ComponentName[]) {
		const outcome = probeOutcomes[name];
		if (!outcome.enabled) {
			components[name] = "disabled";
			continue;
		}
		if (outcome.result?.status === "fulfilled") {
			components[name] = "ok";
			continue;
		}
		components[name] = "unreachable";
		ready = false;
		if (outcome.result?.status === "rejected") {
			errors[name] = errorMessage(outcome.result.reason);
		}
	}

	const snapshot: ReadinessSnapshot = { ready, components, cachedAt };
	if (Object.keys(errors).length > 0) snapshot.errors = errors;
	return snapshot;
}

// SIO-726: createReadinessProbe returns a memoised async function. Returned
// function is the only thing the HTTP route sees -- no class, no DI graph,
// just a closure. Single-value cache (no map) because there's only one
// "readiness" -- no key needed.
export function createReadinessProbe(opts: CreateReadinessProbeOptions): () => Promise<ReadinessSnapshot> {
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = opts.now ?? Date.now;

	let cached: { snapshot: ReadinessSnapshot; expiresAt: number } | null = null;
	let inflight: Promise<ReadinessSnapshot> | null = null;

	async function runProbe(): Promise<ReadinessSnapshot> {
		const startedAt = now();

		// Kafka broker: ticket says clientManager.withAdmin(a => a.metadata({})).
		// withTimeout because admin metadata has no native AbortSignal.
		const kafkaProbe = withTimeout(
			opts.clientManager.withAdmin(async (admin) => {
				await admin.metadata({});
			}),
			timeoutMs,
			"kafka broker metadata probe",
		);

		// Each service's probeReachability already uses AbortSignal.timeout(5000)
		// internally, but wrap defensively in case the timeout is bypassed by a
		// hung TLS handshake or DNS resolution.
		const srProbe = opts.toolOptions.schemaRegistryService
			? withTimeout(
					opts.toolOptions.schemaRegistryService.probeReachability(timeoutMs),
					timeoutMs,
					"schema-registry probe",
				)
			: null;
		const ksqlProbe = opts.toolOptions.ksqlService
			? withTimeout(opts.toolOptions.ksqlService.probeReachability(timeoutMs), timeoutMs, "ksqldb probe")
			: null;
		const connectProbe = opts.toolOptions.connectService
			? withTimeout(opts.toolOptions.connectService.probeReachability(timeoutMs), timeoutMs, "kafka-connect probe")
			: null;
		const rpProbe = opts.toolOptions.restProxyService
			? withTimeout(opts.toolOptions.restProxyService.probeReachability(timeoutMs), timeoutMs, "rest-proxy probe")
			: null;

		const [kafkaResult, srResult, ksqlResult, connectResult, rpResult] = await Promise.allSettled([
			kafkaProbe,
			srProbe ?? Promise.resolve(),
			ksqlProbe ?? Promise.resolve(),
			connectProbe ?? Promise.resolve(),
			rpProbe ?? Promise.resolve(),
		]);

		const outcomes: Record<ComponentName, { enabled: boolean; result: PromiseSettledResult<void> | null }> = {
			kafka: { enabled: true, result: kafkaResult },
			schemaRegistry: { enabled: srProbe !== null, result: srProbe !== null ? srResult : null },
			ksql: { enabled: ksqlProbe !== null, result: ksqlProbe !== null ? ksqlResult : null },
			connect: { enabled: connectProbe !== null, result: connectProbe !== null ? connectResult : null },
			restproxy: { enabled: rpProbe !== null, result: rpProbe !== null ? rpResult : null },
		};

		return buildSnapshot(outcomes, new Date(startedAt).toISOString());
	}

	return async () => {
		const ts = now();
		if (cached && cached.expiresAt > ts) return cached.snapshot;
		// SIO-710-style thundering-herd guard: if a probe is already in flight,
		// concurrent callers share it instead of fanning out to upstreams.
		if (inflight) return inflight;
		inflight = runProbe().finally(() => {
			inflight = null;
		});
		const snapshot = await inflight;
		cached = { snapshot, expiresAt: now() + ttlMs };
		return snapshot;
	};
}
