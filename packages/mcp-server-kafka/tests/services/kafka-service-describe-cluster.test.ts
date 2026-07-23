// tests/services/kafka-service-describe-cluster.test.ts
// SIO-1193: admin.metadata({}) returns brokers/controller but an EMPTY topics map
// with this client, so describeCluster's topicCount was always 0 (audit SIO-1186:
// 0 reported vs 142 live). The count now comes from admin.listTopics().
import { describe, expect, mock, test } from "bun:test";
import type { Admin } from "@platformatic/kafka";
import type { KafkaClientManager } from "../../src/services/client-manager.ts";
import { KafkaService } from "../../src/services/kafka-service.ts";

type MetadataCallback = (err: Error | null, data: unknown) => void;

function buildManager(topicNames: string[]): KafkaClientManager {
	const fakeAdmin = {
		listTopics: mock(async () => topicNames),
		// Mirror the real client: empty opts -> brokers populated, topics EMPTY.
		metadata: mock((_opts: { topics?: string[] }, cb: MetadataCallback) => {
			cb(null, {
				brokers: new Map([
					[1, { host: "b-1.example", port: 9092, rack: "az1" }],
					[2, { host: "b-2.example", port: 9092, rack: "az2" }],
				]),
				controllerId: 2,
				topics: new Map(),
			});
		}),
	} as unknown as Admin;

	return {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
		getProvider: () => ({ type: "msk", name: "AWS MSK (none)" }),
	} as unknown as KafkaClientManager;
}

describe("describeCluster topicCount (SIO-1193)", () => {
	test("counts topics via listTopics instead of the empty metadata map", async () => {
		const service = new KafkaService(buildManager(["topic-a", "topic-b", "topic-c"]));
		const result = await service.describeCluster();
		expect(result.topicCount).toBe(3);
		expect(result.brokerCount).toBe(2);
		expect(result.controllerId).toBe(2);
		expect(result.brokers.find((b) => b.id === 2)?.isController).toBe(true);
	});

	test("falls back to 0 when listTopics fails, without failing the describe", async () => {
		const manager = buildManager([]);
		const admin = {
			listTopics: mock(async () => {
				throw new Error("Listing topics failed.");
			}),
			metadata: mock((_opts: { topics?: string[] }, cb: MetadataCallback) => {
				cb(null, { brokers: new Map([[1, { host: "b-1", port: 9092 }]]), controllerId: 1, topics: new Map() });
			}),
		} as unknown as Admin;
		(manager as unknown as { withAdmin: <T>(fn: (a: Admin) => Promise<T>) => Promise<T> }).withAdmin = async (fn) =>
			fn(admin);
		const service = new KafkaService(manager);
		const result = await service.describeCluster();
		expect(result.topicCount).toBe(0);
		expect(result.brokerCount).toBe(1);
	});
});
