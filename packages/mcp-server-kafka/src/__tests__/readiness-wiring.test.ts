// src/__tests__/readiness-wiring.test.ts
//
// SIO-780: kafka-specific wiring tests for the shared createReadinessProbe.
// The generic TTL / single-flight / timeout / disabled logic lives in
// packages/shared/src/transport/__tests__/readiness.test.ts. This file pins the
// kafka call shape only: kafka -> clientManager.withAdmin(a => a.metadata({})),
// and each optional service -> toolOptions.<service>.probeReachability().

import { describe, expect, test } from "bun:test";
import { createReadinessProbe } from "@devops-agent/shared";
import type { KafkaClientManager } from "../services/client-manager.ts";
import type { ToolRegistrationOptions } from "../tools/index.ts";

interface AdminStub {
	metadata: (arg: object) => Promise<unknown>;
	metadataCalls: number;
}

function makeAdminStub(): AdminStub {
	const stub: AdminStub = {
		metadataCalls: 0,
		metadata: async (_arg: object) => {
			stub.metadataCalls += 1;
			return { topics: [] };
		},
	};
	return stub;
}

function makeClientManager(admin: AdminStub): { manager: KafkaClientManager; withAdminCalls: () => number } {
	let calls = 0;
	const manager = {
		withAdmin: async <T>(fn: (a: AdminStub) => Promise<T>) => {
			calls += 1;
			return fn(admin);
		},
	} as unknown as KafkaClientManager;
	return { manager, withAdminCalls: () => calls };
}

function makeService(): { service: { probeReachability: () => Promise<void> }; calls: () => number } {
	let calls = 0;
	return {
		service: {
			probeReachability: async () => {
				calls += 1;
			},
		},
		calls: () => calls,
	};
}

// Build the same components-map kafka's index.ts builds, so the wiring under
// test matches production exactly.
function buildKafkaComponents(clientManager: KafkaClientManager, toolOptions: ToolRegistrationOptions) {
	const { schemaRegistryService, ksqlService, connectService, restProxyService } = toolOptions;
	return {
		kafka: () =>
			clientManager.withAdmin(async (admin) => {
				await admin.metadata({});
			}),
		schemaRegistry: schemaRegistryService ? () => schemaRegistryService.probeReachability() : null,
		ksql: ksqlService ? () => ksqlService.probeReachability() : null,
		connect: connectService ? () => connectService.probeReachability() : null,
		restproxy: restProxyService ? () => restProxyService.probeReachability() : null,
	};
}

describe("kafka readiness wiring", () => {
	test("kafka component calls clientManager.withAdmin(admin => admin.metadata({}))", async () => {
		const admin = makeAdminStub();
		const { manager, withAdminCalls } = makeClientManager(admin);
		const probe = createReadinessProbe({
			components: buildKafkaComponents(manager, {}),
		});
		const snap = await probe();
		expect(withAdminCalls()).toBe(1);
		expect(admin.metadataCalls).toBe(1);
		expect(snap.components.kafka).toBe("ok");
	});

	test("optional services absent from toolOptions report disabled", async () => {
		const { manager } = makeClientManager(makeAdminStub());
		const probe = createReadinessProbe({
			components: buildKafkaComponents(manager, {}),
		});
		const snap = await probe();
		expect(snap.components.schemaRegistry).toBe("disabled");
		expect(snap.components.ksql).toBe("disabled");
		expect(snap.components.connect).toBe("disabled");
		expect(snap.components.restproxy).toBe("disabled");
		expect(snap.ready).toBe(true);
	});

	test("each optional service in toolOptions triggers its probeReachability()", async () => {
		const { manager } = makeClientManager(makeAdminStub());
		const sr = makeService();
		const ksql = makeService();
		const connect = makeService();
		const restproxy = makeService();
		const toolOptions = {
			schemaRegistryService: sr.service as unknown as ToolRegistrationOptions["schemaRegistryService"],
			ksqlService: ksql.service as unknown as ToolRegistrationOptions["ksqlService"],
			connectService: connect.service as unknown as ToolRegistrationOptions["connectService"],
			restProxyService: restproxy.service as unknown as ToolRegistrationOptions["restProxyService"],
		} satisfies ToolRegistrationOptions;
		const probe = createReadinessProbe({
			components: buildKafkaComponents(manager, toolOptions),
		});
		const snap = await probe();
		expect(sr.calls()).toBe(1);
		expect(ksql.calls()).toBe(1);
		expect(connect.calls()).toBe(1);
		expect(restproxy.calls()).toBe(1);
		expect(snap.components).toEqual({
			kafka: "ok",
			schemaRegistry: "ok",
			ksql: "ok",
			connect: "ok",
			restproxy: "ok",
		});
		expect(snap.ready).toBe(true);
	});
});
