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

describe("KafkaService.listDlqTopics", () => {
	describe("detection", () => {
		test("identifies DLQ topics by suffix patterns", async () => {
			const { manager } = buildClientManager({
				topicNames: ["orders", "orders-dlq", "payments", "dlt-payments", "users", "users-dead-letter", "raw-events"],
				totalMessagesForTopic: () => 0,
			});
			const service = new KafkaService(manager);

			const result = await service.listDlqTopics({ skipDelta: true });
			const names = result.map((r) => r.name).sort();

			expect(names).toEqual(["dlt-payments", "orders-dlq", "users-dead-letter"]);
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

		test("parallelizes large DLQ inventories without exceeding window", async () => {
			const topicNames = Array.from({ length: 50 }, (_, i) => `t${i}-dlq`);

			const { manager } = buildClientManager({
				topicNames,
				totalMessagesForTopic: () => 10,
			});
			const service = new KafkaService(manager);

			const start = Date.now();
			const result = await service.listDlqTopics({ windowMs: 50 });
			const elapsed = Date.now() - start;

			expect(result).toHaveLength(50);
			// All deltas should be 0 (same count both samples)
			for (const entry of result) {
				expect(entry.recentDelta).toBe(0);
			}
			// Should complete well within 500ms even with 50 topics and 50ms window
			expect(elapsed).toBeLessThan(500);
		});
	});
});
