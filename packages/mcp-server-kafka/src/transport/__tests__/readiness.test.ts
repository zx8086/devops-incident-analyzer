// src/transport/__tests__/readiness.test.ts
//
// SIO-726: readiness probe unit tests. Validates the cache TTL, thundering-herd
// inflight guard, enabled-only probing, disabled-component handling, and the
// snapshot shape that drives /ready 503-vs-200 in http.ts.

import { describe, expect, test } from "bun:test";
import type { KafkaClientManager } from "../../services/client-manager.ts";
import type { ToolRegistrationOptions } from "../../tools/index.ts";
import { createReadinessProbe } from "../readiness.ts";

// Minimal Admin shape: metadata() is the only method the probe touches.
function makeAdmin(behaviour: "ok" | "throw" | "hang"): { metadata: (arg: object) => Promise<unknown> } {
	if (behaviour === "ok") return { metadata: async () => ({ topics: [] }) };
	if (behaviour === "throw") {
		return {
			metadata: async () => {
				throw new Error("ECONNREFUSED to broker");
			},
		};
	}
	// "hang": never resolves, used for timeout tests.
	return { metadata: () => new Promise<unknown>(() => {}) };
}

// withAdmin contract: fn receives the admin and the result is returned.
// Builds a structurally-compatible KafkaClientManager stub.
function makeClientManager(adminBehaviour: "ok" | "throw" | "hang"): KafkaClientManager {
	return {
		withAdmin: async <T>(fn: (admin: ReturnType<typeof makeAdmin>) => Promise<T>) => {
			return fn(makeAdmin(adminBehaviour));
		},
	} as unknown as KafkaClientManager;
}

// Service stub: probeReachability is the only method the probe touches.
function makeService(behaviour: "ok" | "throw"): { probeReachability: () => Promise<void> } {
	return {
		probeReachability: async () => {
			if (behaviour === "throw") throw new Error("HTML 503 from upstream");
		},
	};
}

// Bare AppConfig stand-in; readiness.ts doesn't read any field, but the type
// is required by createReadinessProbe.
const stubConfig = {} as Parameters<typeof createReadinessProbe>[0]["config"];

describe("createReadinessProbe", () => {
	test("returns ready: true when kafka broker probe succeeds and no optional services are enabled", async () => {
		const probe = createReadinessProbe({
			clientManager: makeClientManager("ok"),
			toolOptions: {} as ToolRegistrationOptions,
			config: stubConfig,
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components.kafka).toBe("ok");
		expect(snap.components.schemaRegistry).toBe("disabled");
		expect(snap.components.ksql).toBe("disabled");
		expect(snap.components.connect).toBe("disabled");
		expect(snap.components.restproxy).toBe("disabled");
		expect(snap.errors).toBeUndefined();
	});

	test("returns ready: false and unreachable when kafka broker probe throws", async () => {
		const probe = createReadinessProbe({
			clientManager: makeClientManager("throw"),
			toolOptions: {},
			config: stubConfig,
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.kafka).toBe("unreachable");
		expect(snap.errors?.kafka).toContain("ECONNREFUSED");
	});

	test("enabled-only probing: only services present in toolOptions are probed", async () => {
		const ksqlService = makeService("ok") as unknown as ToolRegistrationOptions["ksqlService"];
		const probe = createReadinessProbe({
			clientManager: makeClientManager("ok"),
			toolOptions: { ksqlService },
			config: stubConfig,
		});
		const snap = await probe();
		expect(snap.components.ksql).toBe("ok");
		expect(snap.components.connect).toBe("disabled");
		expect(snap.components.restproxy).toBe("disabled");
		expect(snap.components.schemaRegistry).toBe("disabled");
		expect(snap.ready).toBe(true);
	});

	test("partial failure: one upstream throws -> ready false, others reflect their state", async () => {
		const ksqlOk = makeService("ok") as unknown as ToolRegistrationOptions["ksqlService"];
		const connectDown = makeService("throw") as unknown as ToolRegistrationOptions["connectService"];
		const probe = createReadinessProbe({
			clientManager: makeClientManager("ok"),
			toolOptions: { ksqlService: ksqlOk, connectService: connectDown },
			config: stubConfig,
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.kafka).toBe("ok");
		expect(snap.components.ksql).toBe("ok");
		expect(snap.components.connect).toBe("unreachable");
		expect(snap.errors?.connect).toContain("HTML 503");
		expect(snap.errors?.ksql).toBeUndefined();
	});

	test("cache returns identical snapshot within TTL", async () => {
		const probe = createReadinessProbe({
			clientManager: makeClientManager("ok"),
			toolOptions: {},
			config: stubConfig,
			ttlMs: 30_000,
		});
		const a = await probe();
		const b = await probe();
		expect(a).toBe(b); // same reference (memoised)
		expect(a.cachedAt).toBe(b.cachedAt);
	});

	test("cache advances after TTL expiry (deterministic clock)", async () => {
		let nowValue = 1_000_000;
		const probe = createReadinessProbe({
			clientManager: makeClientManager("ok"),
			toolOptions: {},
			config: stubConfig,
			ttlMs: 30_000,
			now: () => nowValue,
		});
		const a = await probe();
		nowValue += 29_000; // still within TTL
		const b = await probe();
		expect(b.cachedAt).toBe(a.cachedAt);
		nowValue += 2_000; // 31s elapsed total -- past TTL
		const c = await probe();
		expect(c.cachedAt).not.toBe(a.cachedAt);
	});

	test("thundering-herd: concurrent calls during cache miss share a single inflight probe", async () => {
		let probeCalls = 0;
		const clientManager = {
			withAdmin: async <T>(fn: (a: ReturnType<typeof makeAdmin>) => Promise<T>) => {
				probeCalls += 1;
				// Small delay so the second caller arrives while the first is in flight.
				await new Promise((r) => setTimeout(r, 10));
				return fn(makeAdmin("ok"));
			},
		} as unknown as KafkaClientManager;

		const probe = createReadinessProbe({
			clientManager,
			toolOptions: {},
			config: stubConfig,
		});
		const [a, b, c] = await Promise.all([probe(), probe(), probe()]);
		expect(probeCalls).toBe(1);
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	test("kafka admin probe timeout produces unreachable with timeout message", async () => {
		const probe = createReadinessProbe({
			clientManager: makeClientManager("hang"),
			toolOptions: {},
			config: stubConfig,
			timeoutMs: 50,
		});
		const snap = await probe();
		expect(snap.ready).toBe(false);
		expect(snap.components.kafka).toBe("unreachable");
		expect(snap.errors?.kafka).toContain("timed out");
	});

	test("cachedAt is an ISO-8601 timestamp", async () => {
		const probe = createReadinessProbe({
			clientManager: makeClientManager("ok"),
			toolOptions: {},
			config: stubConfig,
		});
		const snap = await probe();
		// ISO-8601: matches "YYYY-MM-DDTHH:MM:SS.sssZ"
		expect(snap.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(new Date(snap.cachedAt).toString()).not.toBe("Invalid Date");
	});

	test("all four optional services together: all ok -> ready true with full components map", async () => {
		const ok = "ok" as const;
		const probe = createReadinessProbe({
			clientManager: makeClientManager("ok"),
			toolOptions: {
				schemaRegistryService: makeService(ok) as unknown as ToolRegistrationOptions["schemaRegistryService"],
				ksqlService: makeService(ok) as unknown as ToolRegistrationOptions["ksqlService"],
				connectService: makeService(ok) as unknown as ToolRegistrationOptions["connectService"],
				restProxyService: makeService(ok) as unknown as ToolRegistrationOptions["restProxyService"],
			},
			config: stubConfig,
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components).toEqual({
			kafka: "ok",
			schemaRegistry: "ok",
			ksql: "ok",
			connect: "ok",
			restproxy: "ok",
		});
		expect(snap.errors).toBeUndefined();
	});

	test("disabled service does NOT fail readiness even if it would have failed", async () => {
		// Service is not provided in toolOptions -> reported as "disabled", not
		// "unreachable", even though the operator might have a misconfigured but
		// intentionally-disabled endpoint sitting there.
		const probe = createReadinessProbe({
			clientManager: makeClientManager("ok"),
			toolOptions: {}, // all four optional services absent
			config: stubConfig,
		});
		const snap = await probe();
		expect(snap.ready).toBe(true);
		expect(snap.components.ksql).toBe("disabled");
	});
});
