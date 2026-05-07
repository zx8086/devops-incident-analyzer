// tests/services/kafka-service-dlq.test.ts
import { describe, expect, mock, test } from "bun:test";
import { type Admin, ListOffsetTimestamps } from "@platformatic/kafka";
import type { KafkaClientManager } from "../../src/services/client-manager.ts";
import { KafkaService } from "../../src/services/kafka-service.ts";

interface ListOffsetsCall {
	topics: Array<{
		name: string;
		partitions: Array<{ partitionIndex: number; timestamp: bigint }>;
	}>;
}

type MetadataCallback = (err: Error | null, data: unknown) => void;

interface FakeAdminOpts {
	// topics returned by admin.listTopics() -- the existing listTopics() wrapper maps these to {name}[]
	topicNames: string[];
	// returns total messages for the given topic at call time; throw to simulate failure
	totalMessagesForTopic: (name: string, callIndex: number) => number;
	// tracks how many times listOffsets has been called per topic
}

function buildClientManager(opts: FakeAdminOpts): { manager: KafkaClientManager; callCounts: Map<string, number> } {
	const callCounts = new Map<string, number>();

	const fakeAdmin = {
		listTopics: mock(async () => opts.topicNames),
		metadata: mock((metaOpts: { topics: string[] }, cb: MetadataCallback) => {
			const topicsMap = new Map<string, { partitions: Record<number, unknown> }>();
			for (const t of metaOpts.topics) {
				topicsMap.set(t, { partitions: { 0: {} } });
			}
			cb(null, { topics: topicsMap });
		}),
		listOffsets: mock(async (req: ListOffsetsCall) => {
			const results: Array<{
				name: string;
				partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
			}> = [];

			for (const topic of req.topics) {
				const count = (callCounts.get(topic.name) ?? 0) + 1;
				callCounts.set(topic.name, count);
				// callIndex is 1-based: first call = 1, second call = 2
				const total = opts.totalMessagesForTopic(topic.name, count);
				results.push({
					name: topic.name,
					partitions: [
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.EARLIEST, offset: 0n },
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.LATEST, offset: BigInt(total) },
					],
				});
			}

			return results;
		}),
	} as unknown as Admin;

	const manager = {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
	} as unknown as KafkaClientManager;

	return { manager, callCounts };
}

// Simulates admin.listOffsets throwing on the first call for a specific topic.
// Used to verify that first-sample failures omit the topic from results entirely.
function buildClientManagerWithFirstSampleFailure(
	topicNames: string[],
	totals: Map<string, number>,
	failTopicOnFirstCall: string,
): { manager: KafkaClientManager } {
	const callCounts = new Map<string, number>();

	const fakeAdmin = {
		listTopics: mock(async () => topicNames),
		metadata: mock((metaOpts: { topics: string[] }, cb: MetadataCallback) => {
			const topicsMap = new Map<string, { partitions: Record<number, unknown> }>();
			for (const t of metaOpts.topics) {
				topicsMap.set(t, { partitions: { 0: {} } });
			}
			cb(null, { topics: topicsMap });
		}),
		listOffsets: mock(async (req: ListOffsetsCall) => {
			const results: Array<{
				name: string;
				partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
			}> = [];

			for (const topic of req.topics) {
				const count = (callCounts.get(topic.name) ?? 0) + 1;
				callCounts.set(topic.name, count);
				if (topic.name === failTopicOnFirstCall && count === 1) {
					throw new Error(`Simulated first-sample failure for ${topic.name}`);
				}
				const total = totals.get(topic.name) ?? 0;
				results.push({
					name: topic.name,
					partitions: [
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.EARLIEST, offset: 0n },
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.LATEST, offset: BigInt(total) },
					],
				});
			}

			return results;
		}),
	} as unknown as Admin;

	const manager = {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
	} as unknown as KafkaClientManager;

	return { manager };
}

// Simulates admin.listOffsets throwing on the second call for a specific topic.
function buildClientManagerWithSecondSampleFailure(
	topicNames: string[],
	firstSampleTotals: Map<string, number>,
): { manager: KafkaClientManager } {
	const callCounts = new Map<string, number>();

	const fakeAdmin = {
		listTopics: mock(async () => topicNames),
		metadata: mock((metaOpts: { topics: string[] }, cb: MetadataCallback) => {
			const topicsMap = new Map<string, { partitions: Record<number, unknown> }>();
			for (const t of metaOpts.topics) {
				topicsMap.set(t, { partitions: { 0: {} } });
			}
			cb(null, { topics: topicsMap });
		}),
		listOffsets: mock(async (req: ListOffsetsCall) => {
			const results: Array<{
				name: string;
				partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
			}> = [];

			for (const topic of req.topics) {
				const count = (callCounts.get(topic.name) ?? 0) + 1;
				callCounts.set(topic.name, count);
				if (count > 1) {
					throw new Error(`Topic ${topic.name} unavailable on second sample`);
				}
				const total = firstSampleTotals.get(topic.name) ?? 0;
				results.push({
					name: topic.name,
					partitions: [
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.EARLIEST, offset: 0n },
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.LATEST, offset: BigInt(total) },
					],
				});
			}

			return results;
		}),
	} as unknown as Admin;

	const manager = {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
	} as unknown as KafkaClientManager;

	return { manager };
}

// Simulates a multi-partition topic where listOffsets returns 6 entries (3 EARLIEST + 3 LATEST).
function buildClientManagerMultiPartition(
	topicName: string,
	partitionCount: number,
	partitionTotals: number[],
): { manager: KafkaClientManager } {
	const fakeAdmin = {
		listTopics: mock(async () => [topicName]),
		metadata: mock((metaOpts: { topics: string[] }, cb: MetadataCallback) => {
			const topicsMap = new Map<string, { partitions: Record<number, unknown> }>();
			for (const t of metaOpts.topics) {
				const partitions: Record<number, unknown> = {};
				for (let i = 0; i < partitionCount; i++) {
					partitions[i] = {};
				}
				topicsMap.set(t, { partitions });
			}
			cb(null, { topics: topicsMap });
		}),
		listOffsets: mock(async (req: ListOffsetsCall) => {
			const results: Array<{
				name: string;
				partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
			}> = [];

			for (const topic of req.topics) {
				const partitionEntries: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }> = [];
				// Each request entry carries its timestamp; reflect it back with the correct offset.
				for (const { partitionIndex, timestamp } of topic.partitions) {
					const total = partitionTotals[partitionIndex] ?? 0;
					const offset = timestamp === ListOffsetTimestamps.LATEST ? BigInt(total) : 0n;
					partitionEntries.push({ partitionIndex, timestamp, offset });
				}
				results.push({ name: topic.name, partitions: partitionEntries });
			}

			return results;
		}),
	} as unknown as Admin;

	const manager = {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
	} as unknown as KafkaClientManager;

	return { manager };
}

// Simulates two DLQ topics where only the second sample of one topic fails.
function buildClientManagerWithMixedSecondSampleFailure(
	topicNames: string[],
	firstSampleTotals: Map<string, number>,
	failSecondSampleTopic: string,
): { manager: KafkaClientManager } {
	const callCounts = new Map<string, number>();

	const fakeAdmin = {
		listTopics: mock(async () => topicNames),
		metadata: mock((metaOpts: { topics: string[] }, cb: MetadataCallback) => {
			const topicsMap = new Map<string, { partitions: Record<number, unknown> }>();
			for (const t of metaOpts.topics) {
				topicsMap.set(t, { partitions: { 0: {} } });
			}
			cb(null, { topics: topicsMap });
		}),
		listOffsets: mock(async (req: ListOffsetsCall) => {
			const results: Array<{
				name: string;
				partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
			}> = [];

			for (const topic of req.topics) {
				const count = (callCounts.get(topic.name) ?? 0) + 1;
				callCounts.set(topic.name, count);
				if (topic.name === failSecondSampleTopic && count > 1) {
					throw new Error(`Simulated second-sample failure for ${topic.name}`);
				}
				const total = firstSampleTotals.get(topic.name) ?? 0;
				results.push({
					name: topic.name,
					partitions: [
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.EARLIEST, offset: 0n },
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.LATEST, offset: BigInt(total) },
					],
				});
			}

			return results;
		}),
	} as unknown as Admin;

	const manager = {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
	} as unknown as KafkaClientManager;

	return { manager };
}

describe("KafkaService.listDlqTopics", () => {
	describe("detection", () => {
		test("identifies DLQ topics by suffix patterns", async () => {
			const { manager } = buildClientManager({
				topicNames: [
					"orders",
					"orders-dlq",
					"payments",
					"dlt-payments",
					"users",
					"users-dead-letter",
					"raw-events",
					"dead-letter-payments",
					"orders.DLQ",
				],
				totalMessagesForTopic: () => 0,
			});
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ skipDelta: true });
			const names = result.map((r) => r.name).sort();

			expect(names).toEqual(["dead-letter-payments", "dlt-payments", "orders-dlq", "orders.DLQ", "users-dead-letter"]);
		});

		test("returns empty array when no DLQ topics present", async () => {
			const { manager } = buildClientManager({
				topicNames: ["orders", "payments"],
				totalMessagesForTopic: () => 0,
			});
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ skipDelta: true });

			expect(result).toEqual([]);
		});
	});

	describe("recentDelta", () => {
		test("computes positive delta when second sample is higher", async () => {
			const { manager } = buildClientManager({
				topicNames: ["orders-dlq"],
				totalMessagesForTopic: (_name, callIndex) => (callIndex === 1 ? 100 : 105),
			});
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe("orders-dlq");
			expect(result[0]?.totalMessages).toBe(100);
			expect(result[0]?.recentDelta).toBe(5);
		});

		test("zero delta when second sample matches first", async () => {
			const { manager } = buildClientManager({
				topicNames: ["orders-dlq"],
				totalMessagesForTopic: () => 100,
			});
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(1);
			expect(result[0]?.totalMessages).toBe(100);
			expect(result[0]?.recentDelta).toBe(0);
		});

		test("recentDelta is null when second sample fails", async () => {
			const firstSampleTotals = new Map([["orders-dlq", 100]]);
			const { manager } = buildClientManagerWithSecondSampleFailure(["orders-dlq"], firstSampleTotals);
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(1);
			expect(result[0]?.totalMessages).toBe(100);
			expect(result[0]?.recentDelta).toBeNull();
		});

		test("returns all 50 DLQ entries with correct deltas across batches", async () => {
			const topicNames = Array.from({ length: 50 }, (_, i) => `t${i}-dlq`);

			const { manager } = buildClientManager({
				topicNames,
				totalMessagesForTopic: () => 10,
			});
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(50);
			// Both samples return identical totals so recentDelta must be 0 for every entry.
			for (const entry of result) {
				expect(entry.totalMessages).toBe(10);
				expect(entry.recentDelta).toBe(0);
			}
			// All 50 topic names are present in the result.
			const resultNames = new Set(result.map((r) => r.name));
			for (const name of topicNames) {
				expect(resultNames.has(name)).toBe(true);
			}
		});

		test("first-sample failure omits the topic from results entirely", async () => {
			// topic-a fails on the first sample; topic-b succeeds both samples.
			// Expect: result has only topic-b, no entry for topic-a.
			const totals = new Map([
				["topic-a-dlq", 50],
				["topic-b-dlq", 80],
			]);
			const { manager } = buildClientManagerWithFirstSampleFailure(
				["topic-a-dlq", "topic-b-dlq"],
				totals,
				"topic-a-dlq",
			);
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ windowMs: 1 });
			const names = result.map((r) => r.name);

			expect(names).not.toContain("topic-a-dlq");
			expect(names).toContain("topic-b-dlq");
			expect(result).toHaveLength(1);
		});

		test("mixed second-sample failure: one topic gets numeric delta, other gets null", async () => {
			// topic-good-dlq succeeds both samples; topic-bad-dlq fails on the second sample.
			const firstSampleTotals = new Map([
				["topic-good-dlq", 200],
				["topic-bad-dlq", 300],
			]);
			const { manager } = buildClientManagerWithMixedSecondSampleFailure(
				["topic-good-dlq", "topic-bad-dlq"],
				firstSampleTotals,
				"topic-bad-dlq",
			);
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(2);
			const good = result.find((r) => r.name === "topic-good-dlq");
			const bad = result.find((r) => r.name === "topic-bad-dlq");

			expect(good).toBeDefined();
			expect(typeof good?.recentDelta).toBe("number");

			expect(bad).toBeDefined();
			expect(bad?.recentDelta).toBeNull();
		});

		test("multi-partition DLQ sums message count correctly across 3 partitions", async () => {
			// DLQ with 3 partitions: 100, 200, 300 messages respectively = 600 total.
			const { manager } = buildClientManagerMultiPartition("orders-dlq", 3, [100, 200, 300]);
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ skipDelta: true });

			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe("orders-dlq");
			expect(result[0]?.totalMessages).toBe(600);
			expect(result[0]?.recentDelta).toBeNull();
		});
	});
});
