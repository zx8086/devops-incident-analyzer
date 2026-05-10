// tests/services/client-manager.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// SIO-710: substitute @platformatic/kafka before importing client-manager so the
// constructor we observe is our spy. mock.module is hoisted by Bun ahead of imports.
const adminCtorSpy = mock(
	(_opts: unknown) =>
		({
			closed: false,
			close: mock(async () => {}),
		}) as { closed: boolean; close: ReturnType<typeof mock> },
);
const producerCtorSpy = mock(
	(_opts: unknown) =>
		({
			closed: false,
			close: mock(async () => {}),
		}) as { closed: boolean; close: ReturnType<typeof mock> },
);
const consumerCtorSpy = mock(
	(_opts: unknown) =>
		({
			closed: false,
			close: mock(async () => {}),
		}) as { closed: boolean; close: ReturnType<typeof mock> },
);

mock.module("@platformatic/kafka", () => ({
	Admin: function MockAdmin(opts: unknown) {
		return adminCtorSpy(opts);
	},
	Producer: function MockProducer(opts: unknown) {
		return producerCtorSpy(opts);
	},
	Consumer: function MockConsumer(opts: unknown) {
		return consumerCtorSpy(opts);
	},
}));

import type { KafkaConnectionConfig, KafkaProvider } from "../../src/providers/types.ts";
import { KafkaClientManager } from "../../src/services/client-manager.ts";

function buildProvider(overrides: Partial<KafkaConnectionConfig> = {}): KafkaProvider {
	return {
		type: "local",
		name: "test-provider",
		getConnectionConfig: async () => ({
			clientId: "test-client",
			bootstrapBrokers: ["localhost:9092"],
			...overrides,
		}),
		close: async () => {},
	};
}

beforeEach(() => {
	adminCtorSpy.mockClear();
	producerCtorSpy.mockClear();
	consumerCtorSpy.mockClear();
});

describe("KafkaClientManager admin singleton (SIO-710)", () => {
	test("reuses a single Admin across 20 sequential withAdmin calls", async () => {
		const mgr = new KafkaClientManager(buildProvider());
		const results: number[] = [];

		for (let i = 1; i <= 20; i++) {
			const value = await mgr.withAdmin(async () => i);
			results.push(value);
		}

		expect(adminCtorSpy).toHaveBeenCalledTimes(1);
		expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

		await mgr.close();
		const adminInstance = adminCtorSpy.mock.results[0]?.value as { close: ReturnType<typeof mock> };
		expect(adminInstance.close).toHaveBeenCalledTimes(1);
	});

	test("rebuilds the Admin if the previous one was closed", async () => {
		const mgr = new KafkaClientManager(buildProvider());

		await mgr.withAdmin(async () => "first");
		const firstAdmin = adminCtorSpy.mock.results[0]?.value as { closed: boolean };
		firstAdmin.closed = true;

		await mgr.withAdmin(async () => "second");

		expect(adminCtorSpy).toHaveBeenCalledTimes(2);
	});

	test("concurrent withAdmin callers share a single Admin construction (thundering-herd guard)", async () => {
		const mgr = new KafkaClientManager(buildProvider());

		const calls = await Promise.all(Array.from({ length: 10 }, (_, i) => mgr.withAdmin(async () => i)));

		expect(adminCtorSpy).toHaveBeenCalledTimes(1);
		expect(calls).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});
});

describe("KafkaClientManager toolTimeoutMs (SIO-710)", () => {
	test("forwards toolTimeoutMs into platformatic Admin options as 'timeout'", async () => {
		const mgr = new KafkaClientManager(buildProvider(), 12_345);

		await mgr.withAdmin(async () => null);

		const opts = adminCtorSpy.mock.calls[0]?.[0] as { timeout?: number };
		expect(opts.timeout).toBe(12_345);
	});

	test("provider-supplied timeout wins over the manager-level default", async () => {
		const mgr = new KafkaClientManager(buildProvider({ timeout: 60_000 }), 12_345);

		await mgr.withAdmin(async () => null);

		const opts = adminCtorSpy.mock.calls[0]?.[0] as { timeout?: number };
		expect(opts.timeout).toBe(60_000);
	});

	test("does not race fn(admin) against an outer timer", async () => {
		// Regression guard: an earlier draft used Promise.race with an outer timer,
		// but @platformatic/kafka's own `timeout` option already binds first. We must
		// not reject a slow tool call just because the manager's tool timeout is short.
		const mgr = new KafkaClientManager(buildProvider(), 50);

		const result = await mgr.withAdmin(
			async () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 100)),
		);

		expect(result).toBe("ok");
	});
});

describe("KafkaClientManager backward-compat with kafka-service tests", () => {
	test("withAdmin signature remains <T>(fn: (admin) => Promise<T>) => Promise<T>", async () => {
		// The other kafka-service-*.test.ts files fake the manager as
		// `{ withAdmin: async (fn) => fn(fakeAdmin) }`. This test pins the contract.
		const mgr = new KafkaClientManager(buildProvider());

		const value = await mgr.withAdmin(async (admin) => {
			expect(admin).toBeDefined();
			return 42;
		});

		expect(value).toBe(42);
	});
});

afterEach(async () => {
	// no-op; left as a placeholder for future cleanup if mock.module gains state
});
