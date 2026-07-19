// tests/services/kafka-service-dlq.test.ts
import { describe, expect, mock, test } from "bun:test";
import { type Admin, ListOffsetTimestamps } from "@platformatic/kafka";
import type { KafkaClientManager } from "../../src/services/client-manager.ts";
import {
	DEFAULT_DLQ_DELTA_WINDOW_MS,
	DLQ_AUTO_SKIP_DELTA_THRESHOLD,
	KafkaService,
} from "../../src/services/kafka-service.ts";

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

// SIO-1157: mirrors the live broker -- duplicate partitionIndex entries within one
// topic request are REJECTED. The old dual-sentinel shape passed only because the
// previous fake accepted duplicates; every test now runs against broker semantics.
function assertNoDuplicatePartitions(req: ListOffsetsCall): void {
	for (const topic of req.topics) {
		const seen = new Set<number>();
		for (const p of topic.partitions) {
			if (seen.has(p.partitionIndex)) {
				throw new Error(`Duplicate partition ${p.partitionIndex} for topic ${topic.name} in ListOffsets request`);
			}
			seen.add(p.partitionIndex);
		}
	}
}

// A request is a LATEST-sentinel pass when every entry carries LATEST; sample
// accounting (callIndex 1 = first sample, 2 = second) counts those passes only,
// preserving the pre-SIO-1157 test semantics under the two-call shape.
function isLatestPass(topic: ListOffsetsCall["topics"][number]): boolean {
	return topic.partitions.every((p) => p.timestamp === ListOffsetTimestamps.LATEST);
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
			assertNoDuplicatePartitions(req);
			const results: Array<{
				name: string;
				partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
			}> = [];

			for (const topic of req.topics) {
				let total = 0;
				if (isLatestPass(topic)) {
					const count = (callCounts.get(topic.name) ?? 0) + 1;
					callCounts.set(topic.name, count);
					// callIndex is 1-based: first sample = 1, second sample = 2
					total = opts.totalMessagesForTopic(topic.name, count);
				}
				results.push({
					name: topic.name,
					partitions: topic.partitions.map((p) => ({
						partitionIndex: p.partitionIndex,
						timestamp: p.timestamp,
						offset: p.timestamp === ListOffsetTimestamps.EARLIEST ? 0n : BigInt(total),
					})),
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
			assertNoDuplicatePartitions(req);
			const results: Array<{
				name: string;
				partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
			}> = [];

			for (const topic of req.topics) {
				if (isLatestPass(topic)) {
					const count = (callCounts.get(topic.name) ?? 0) + 1;
					callCounts.set(topic.name, count);
					if (topic.name === failTopicOnFirstCall && count === 1) {
						throw new Error(`Simulated first-sample failure for ${topic.name}`);
					}
				}
				const total = totals.get(topic.name) ?? 0;
				results.push({
					name: topic.name,
					partitions: topic.partitions.map((p) => ({
						partitionIndex: p.partitionIndex,
						timestamp: p.timestamp,
						offset: p.timestamp === ListOffsetTimestamps.EARLIEST ? 0n : BigInt(total),
					})),
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
			assertNoDuplicatePartitions(req);
			const results: Array<{
				name: string;
				partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
			}> = [];

			for (const topic of req.topics) {
				if (isLatestPass(topic)) {
					const count = (callCounts.get(topic.name) ?? 0) + 1;
					callCounts.set(topic.name, count);
					if (count > 1) {
						throw new Error(`Topic ${topic.name} unavailable on second sample`);
					}
				}
				const total = firstSampleTotals.get(topic.name) ?? 0;
				results.push({
					name: topic.name,
					partitions: topic.partitions.map((p) => ({
						partitionIndex: p.partitionIndex,
						timestamp: p.timestamp,
						offset: p.timestamp === ListOffsetTimestamps.EARLIEST ? 0n : BigInt(total),
					})),
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
			assertNoDuplicatePartitions(req);
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
			assertNoDuplicatePartitions(req);
			const results: Array<{
				name: string;
				partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
			}> = [];

			for (const topic of req.topics) {
				if (isLatestPass(topic)) {
					const count = (callCounts.get(topic.name) ?? 0) + 1;
					callCounts.set(topic.name, count);
					if (topic.name === failSecondSampleTopic && count > 1) {
						throw new Error(`Simulated second-sample failure for ${topic.name}`);
					}
				}
				const total = firstSampleTotals.get(topic.name) ?? 0;
				results.push({
					name: topic.name,
					partitions: topic.partitions.map((p) => ({
						partitionIndex: p.partitionIndex,
						timestamp: p.timestamp,
						offset: p.timestamp === ListOffsetTimestamps.EARLIEST ? 0n : BigInt(total),
					})),
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

			const { topics: result } = await service.listDlqTopics({ skipDelta: true });
			const names = result.map((r) => r.name).sort();

			expect(names).toEqual(["dead-letter-payments", "dlt-payments", "orders-dlq", "orders.DLQ", "users-dead-letter"]);
		});

		test("returns empty array when no DLQ topics present", async () => {
			const { manager } = buildClientManager({
				topicNames: ["orders", "payments"],
				totalMessagesForTopic: () => 0,
			});
			const service = new KafkaService(manager);

			const { topics: result } = await service.listDlqTopics({ skipDelta: true });

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

			const { topics: result } = await service.listDlqTopics({ windowMs: 1 });

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

			const { topics: result } = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(1);
			expect(result[0]?.totalMessages).toBe(100);
			expect(result[0]?.recentDelta).toBe(0);
		});

		test("recentDelta is null when second sample fails", async () => {
			const firstSampleTotals = new Map([["orders-dlq", 100]]);
			const { manager } = buildClientManagerWithSecondSampleFailure(["orders-dlq"], firstSampleTotals);
			const service = new KafkaService(manager);

			const { topics: result } = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(1);
			expect(result[0]?.totalMessages).toBe(100);
			expect(result[0]?.recentDelta).toBeNull();
		});

		// SIO-1150: above DLQ_AUTO_SKIP_DELTA_THRESHOLD the delta window is skipped
		// automatically (single sample, recentDelta null) so a DLQ-heavy cluster
		// cannot push the call past the client timeout. Batch coverage (50 topics =
		// 3 parallel batches) is preserved via totalMessages.
		test("auto-skips the delta window above the threshold: 50 topics, one sample, null deltas", async () => {
			const topicNames = Array.from({ length: 50 }, (_, i) => `t${i}-dlq`);

			const { manager, callCounts } = buildClientManager({
				topicNames,
				totalMessagesForTopic: () => 10,
			});
			const service = new KafkaService(manager);

			const { topics: result } = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(50);
			for (const entry of result) {
				expect(entry.totalMessages).toBe(10);
				expect(entry.recentDelta).toBeNull();
			}
			const resultNames = new Set(result.map((r) => r.name));
			for (const name of topicNames) {
				expect(resultNames.has(name)).toBe(true);
			}
			// Single-sample path: exactly one listOffsets call per topic.
			for (const name of topicNames) {
				expect(callCounts.get(name)).toBe(1);
			}
		});

		test("still computes deltas at the threshold boundary", async () => {
			const topicNames = Array.from({ length: DLQ_AUTO_SKIP_DELTA_THRESHOLD }, (_, i) => `t${i}-dlq`);
			const { manager } = buildClientManager({
				topicNames,
				totalMessagesForTopic: (_name, callIndex) => (callIndex === 1 ? 10 : 14),
			});
			const service = new KafkaService(manager);

			const { topics: result } = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(DLQ_AUTO_SKIP_DELTA_THRESHOLD);
			for (const entry of result) {
				expect(entry.recentDelta).toBe(4);
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

			const { topics: result } = await service.listDlqTopics({ windowMs: 1 });
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

			const { topics: result } = await service.listDlqTopics({ windowMs: 1 });

			expect(result).toHaveLength(2);
			const good = result.find((r) => r.name === "topic-good-dlq");
			const bad = result.find((r) => r.name === "topic-bad-dlq");

			expect(good).toBeDefined();
			expect(typeof good?.recentDelta).toBe("number");

			expect(bad).toBeDefined();
			expect(bad?.recentDelta).toBeNull();
		});

		// The kafka-mcp client's per-call tool timeout is 30s (mcp-bridge.ts
		// KAFKA_TOOL_TIMEOUT_DEFAULT_MS). listDlqTopics sleeps for the full windowMs as
		// part of its own logic, wrapped by a listTopics() scan and two sampleDlqOffsets()
		// admin round trips -- so the default window must leave real margin under 30s,
		// not equal it (equal-with-zero-margin previously caused a guaranteed -32001
		// timeout under any nonzero network latency).
		test("default delta window leaves margin under the 30s client tool-call timeout", () => {
			const KAFKA_TOOL_TIMEOUT_DEFAULT_MS = 30_000;
			expect(DEFAULT_DLQ_DELTA_WINDOW_MS).toBeLessThan(KAFKA_TOOL_TIMEOUT_DEFAULT_MS);
			// Require a healthy margin (not just "less than") for the two admin round trips.
			expect(KAFKA_TOOL_TIMEOUT_DEFAULT_MS - DEFAULT_DLQ_DELTA_WINDOW_MS).toBeGreaterThanOrEqual(15_000);
		});

		test("multi-partition DLQ sums message count correctly across 3 partitions", async () => {
			// DLQ with 3 partitions: 100, 200, 300 messages respectively = 600 total.
			const { manager } = buildClientManagerMultiPartition("orders-dlq", 3, [100, 200, 300]);
			const service = new KafkaService(manager);

			const { topics: result } = await service.listDlqTopics({ skipDelta: true });

			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe("orders-dlq");
			expect(result[0]?.totalMessages).toBe(600);
			expect(result[0]?.recentDelta).toBeNull();
		});
	});
});

// SIO-1150: pattern coverage (case-insensitive + the DLQ_-prefix convention),
// the filter bound, and the batched partition-metadata RPC.
describe("SIO-1150 DLQ listing", () => {
	test("detects DLQ_-prefixed, dotted, and mixed-case DLQ names", async () => {
		const topicNames = [
			"DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS",
			"orders.DLQ",
			"MY-SERVICE-DLQ",
			"dlt-payments",
			"dead-letter-images",
			"T_PRIVATE_STOCK_RICH_NOTIFICATIONS",
			"regular-topic",
		];
		const { manager } = buildClientManager({ topicNames, totalMessagesForTopic: () => 5 });
		const service = new KafkaService(manager);

		const { topics: result } = await service.listDlqTopics({ skipDelta: true });
		const names = new Set(result.map((r) => r.name));
		expect(names).toEqual(
			new Set([
				"DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS",
				"orders.DLQ",
				"MY-SERVICE-DLQ",
				"dlt-payments",
				"dead-letter-images",
			]),
		);
	});

	test("filter bounds the candidate set case-insensitively without regex semantics", async () => {
		const topicNames = ["DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS", "DLQ_T_PRIVATE_PRICE_NOTIFICATIONS", "orders-dlq"];
		const { manager, callCounts } = buildClientManager({ topicNames, totalMessagesForTopic: () => 5 });
		const service = new KafkaService(manager);

		const { topics: result } = await service.listDlqTopics({ skipDelta: true, filter: "variant" });
		expect(result.map((r) => r.name)).toEqual(["DLQ_T_PRIVATE_VARIANT_RICH_NOTIFICATIONS"]);
		// Unmatched candidates are never sampled.
		expect(callCounts.has("orders-dlq")).toBe(false);
		expect(callCounts.has("DLQ_T_PRIVATE_PRICE_NOTIFICATIONS")).toBe(false);
	});

	test("resolves partition indices with one batched metadata RPC per sample batch", async () => {
		const topicNames = Array.from({ length: 5 }, (_, i) => `t${i}-dlq`);
		const { manager } = buildClientManager({ topicNames, totalMessagesForTopic: () => 5 });
		const service = new KafkaService(manager);
		const admin = await (
			manager as unknown as { withAdmin: <T>(fn: (a: unknown) => Promise<T>) => Promise<T> }
		).withAdmin(async (a) => a);
		const metadataMock = (admin as { metadata: { mock: { calls: unknown[][] } } }).metadata;
		metadataMock.mock.calls.length = 0;

		await service.listDlqTopics({ skipDelta: true });
		// One batched call for the 5-topic batch, not one per topic.
		expect(metadataMock.mock.calls.length).toBe(1);
		expect((metadataMock.mock.calls[0]?.[0] as { topics: string[] }).topics).toHaveLength(5);
	});
});

// SIO-1157: the dual-sentinel shape put duplicate partitionIndex entries into one
// broker ListOffsets request, which live brokers reject; the rejection was silently
// swallowed and the tool returned []. Every fake above now rejects duplicates
// (broker semantics), so the whole suite regresses on the old shape; this test
// additionally locks the request shape itself.
describe("SIO-1157 single-sentinel sampling", () => {
	test("every listOffsets request is single-sentinel with unique partitions", async () => {
		const requests: ListOffsetsCall[] = [];
		const topicNames = ["orders-dlq"];
		const fakeAdmin = {
			listTopics: mock(async () => topicNames),
			metadata: mock((metaOpts: { topics: string[] }, cb: MetadataCallback) => {
				const topicsMap = new Map<string, { partitions: Record<number, unknown> }>();
				for (const t of metaOpts.topics) topicsMap.set(t, { partitions: { 0: {}, 1: {} } });
				cb(null, { topics: topicsMap });
			}),
			listOffsets: mock(async (req: ListOffsetsCall) => {
				assertNoDuplicatePartitions(req);
				requests.push(req);
				return req.topics.map((topic) => ({
					name: topic.name,
					partitions: topic.partitions.map((p) => ({
						partitionIndex: p.partitionIndex,
						timestamp: p.timestamp,
						offset: p.timestamp === ListOffsetTimestamps.EARLIEST ? 5n : 105n,
					})),
				}));
			}),
		} as unknown as Admin;
		const manager = {
			withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
		} as unknown as KafkaClientManager;
		const service = new KafkaService(manager);

		const result = await service.listDlqTopics({ skipDelta: true });

		// SIO-1159 merge: listDlqTopics now returns the diagnostics wrapper.
		expect(result.topics).toEqual([{ name: "orders-dlq", totalMessages: 200, recentDelta: null }]);
		// Two calls (EARLIEST pass, LATEST pass), each with one sentinel across both partitions.
		expect(requests).toHaveLength(2);
		for (const req of requests) {
			for (const topic of req.topics) {
				const sentinels = new Set(topic.partitions.map((p) => p.timestamp));
				expect(sentinels.size).toBe(1);
				expect(topic.partitions).toHaveLength(2);
			}
		}
	});
});

// SIO-1159: diagnostics wrapper -- an empty topics list is never ambiguous. matched
// counts DLQ-named topics, sampleFailed counts those silently omitted by failed
// offset sampling (run 270378e0 could not tell "no DLQs" from "all samples failed").
describe("SIO-1159 DLQ diagnostics wrapper", () => {
	test("zero pattern matches: matched 0 with a naming-conventions note", async () => {
		const { manager } = buildClientManager({
			topicNames: ["orders", "payments"],
			totalMessagesForTopic: () => 0,
		});
		const service = new KafkaService(manager);

		const result = await service.listDlqTopics({ skipDelta: true });

		expect(result.topics).toEqual([]);
		expect(result.matched).toBe(0);
		expect(result.sampleFailed).toBe(0);
		expect(result.note).toContain("No topic names matched the DLQ naming conventions");
	});

	test("zero matches after a filter bound names the filter in the note", async () => {
		const { manager } = buildClientManager({
			topicNames: ["orders-dlq"],
			totalMessagesForTopic: () => 0,
		});
		const service = new KafkaService(manager);

		const result = await service.listDlqTopics({ skipDelta: true, filter: "variant" });

		expect(result.topics).toEqual([]);
		expect(result.matched).toBe(0);
		expect(result.note).toContain('"variant"');
	});

	test("sample failure is surfaced: matched 2, sampleFailed 1 with the failed topic NAMED", async () => {
		const totals = new Map([
			["topic-a-dlq", 50],
			["topic-b-dlq", 80],
		]);
		const { manager } = buildClientManagerWithFirstSampleFailure(["topic-a-dlq", "topic-b-dlq"], totals, "topic-a-dlq");
		const service = new KafkaService(manager);

		const result = await service.listDlqTopics({ windowMs: 1 });

		expect(result.matched).toBe(2);
		expect(result.sampleFailed).toBe(1);
		expect(result.sampleFailedTopics).toEqual(["topic-a-dlq"]);
		expect(result.topics.map((t) => t.name)).toEqual(["topic-b-dlq"]);
		expect(result.note).toContain("1 of 2 DLQ-named topics were omitted");
		expect(result.note).toContain("EXIST");
		expect(result.note).toContain("sampleFailedTopics");
	});

	test("healthy result carries counts, no note, no sampleFailedTopics", async () => {
		const { manager } = buildClientManager({
			topicNames: ["orders-dlq"],
			totalMessagesForTopic: () => 5,
		});
		const service = new KafkaService(manager);

		const result = await service.listDlqTopics({ skipDelta: true });

		expect(result.matched).toBe(1);
		expect(result.sampleFailed).toBe(0);
		expect(result.sampleFailedTopics).toBeUndefined();
		expect(result.note).toBeUndefined();
	});
});
