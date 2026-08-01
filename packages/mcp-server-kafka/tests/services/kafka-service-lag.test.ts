// tests/services/kafka-service-lag.test.ts
import { describe, expect, test } from "bun:test";
import type { Admin } from "@platformatic/kafka";
import type { KafkaClientManager } from "../../src/services/client-manager.ts";
import { KafkaService } from "../../src/services/kafka-service.ts";

// SIO-1334: kafka_get_consumer_group_lag used to return {topics:[], totalLag:"0"}
// for a nonexistent/deleted group -- identical to a genuinely healthy zero-lag
// group. groupState (from describeGroups, "Dead" for a nonexistent group) is the
// disambiguator, mirroring describeConsumerGroup's own existence signal.

function buildAdmin(overrides: Partial<Admin>): Admin {
	return {
		listConsumerGroupOffsets: async () => [],
		describeGroups: async () => new Map(),
		...overrides,
	} as unknown as Admin;
}

function buildClientManager(admin: Admin): KafkaClientManager {
	return {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(admin),
	} as unknown as KafkaClientManager;
}

describe("KafkaService.getConsumerGroupLag SIO-1334 groupState disambiguation", () => {
	test("a nonexistent group surfaces groupState=Dead alongside the vacuous zero lag", async () => {
		const admin = buildAdmin({
			listConsumerGroupOffsets: async () => [],
			describeGroups: async () =>
				new Map([["ghost-group", { state: "Dead", protocol: "", members: new Map() } as never]]),
		});
		const service = new KafkaService(buildClientManager(admin));

		const result = await service.getConsumerGroupLag("ghost-group");

		expect(result.topics).toEqual([]);
		expect(result.totalLag).toBe("0");
		expect(result.groupState).toBe("Dead");
	});

	test("a real group with genuinely zero lag has no topics + a live groupState (not Dead)", async () => {
		const admin = buildAdmin({
			listConsumerGroupOffsets: async () => [{ groupId: "empty-group", topics: [] }],
			describeGroups: async () =>
				new Map([["empty-group", { state: "Empty", protocol: "", members: new Map() } as never]]),
		});
		const service = new KafkaService(buildClientManager(admin));

		const result = await service.getConsumerGroupLag("empty-group");

		expect(result.topics).toEqual([]);
		expect(result.totalLag).toBe("0");
		expect(result.groupState).toBe("Empty");
	});

	test("describeGroups failure soft-fails: lag numbers still returned, groupState simply absent", async () => {
		const admin = buildAdmin({
			listConsumerGroupOffsets: async () => [],
			describeGroups: async () => {
				throw new Error("coordinator unavailable");
			},
		});
		const service = new KafkaService(buildClientManager(admin));

		const result = await service.getConsumerGroupLag("some-group");

		expect(result.topics).toEqual([]);
		expect(result.totalLag).toBe("0");
		expect(result.groupState).toBeUndefined();
	});

	// CodeRabbit (PR #562): the prior soft-fail test only covered the zero-lag
	// path, so a regression that let a describeGroups failure clobber a REAL,
	// nonzero lag calculation (not just omit groupState) would have passed
	// unnoticed. Assert the lag numbers survive untouched.
	test("describeGroups failure soft-fails even when the group has real nonzero lag", async () => {
		const admin = buildAdmin({
			listConsumerGroupOffsets: async () => [
				{
					groupId: "active-group",
					topics: [
						{
							name: "topic-a",
							partitions: [{ partitionIndex: 0, committedOffset: 10n, committedLeaderEpoch: 0, metadata: null }],
						},
					],
				},
			],
			describeGroups: async () => {
				throw new Error("coordinator unavailable");
			},
		});
		(admin as unknown as { listOffsets: Admin["listOffsets"] }).listOffsets = (async () => [
			{ name: "topic-a", partitions: [{ partitionIndex: 0, offset: 15n }] },
		]) as unknown as Admin["listOffsets"];
		const service = new KafkaService(buildClientManager(admin));

		const result = await service.getConsumerGroupLag("active-group");

		expect(result.totalLag).toBe("5");
		expect(result.topics[0]?.totalLag).toBe("5");
		expect(result.groupState).toBeUndefined();
	});

	test("a group with real committed offsets and lag also carries groupState", async () => {
		const admin = buildAdmin({
			listConsumerGroupOffsets: async () => [
				{
					groupId: "active-group",
					topics: [
						{
							name: "topic-a",
							partitions: [{ partitionIndex: 0, committedOffset: 10n, committedLeaderEpoch: 0, metadata: null }],
						},
					],
				},
			],
			describeGroups: async () =>
				new Map([["active-group", { state: "Stable", protocol: "range", members: new Map() } as never]]),
		});
		// listOffsets is called per-topic inside getConsumerGroupLag for the LATEST bound.
		(admin as unknown as { listOffsets: Admin["listOffsets"] }).listOffsets = (async () => [
			{ name: "topic-a", partitions: [{ partitionIndex: 0, offset: 15n }] },
		]) as unknown as Admin["listOffsets"];
		const service = new KafkaService(buildClientManager(admin));

		const result = await service.getConsumerGroupLag("active-group");

		expect(result.totalLag).toBe("5");
		expect(result.groupState).toBe("Stable");
	});
});
