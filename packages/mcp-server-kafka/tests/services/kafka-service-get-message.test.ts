// tests/services/kafka-service-get-message.test.ts
import { describe, expect, mock, test } from "bun:test";
import { type Admin, ListOffsetTimestamps, MultipleErrors } from "@platformatic/kafka";
import type { KafkaClientManager } from "../../src/services/client-manager.ts";
import { KafkaService } from "../../src/services/kafka-service.ts";

interface ListOffsetsCall {
	topics: Array<{
		name: string;
		partitions: Array<{ partitionIndex: number; timestamp: bigint }>;
	}>;
}

// Fake helper for the SIO-700 dual-call shape (one EARLIEST call + one LATEST call).
// Test authors supply the offset value for each timestamp; the fake routes by request.
function bounds(spec: { name: string; partitionIndex: number; earliest: bigint; latest: bigint }) {
	return (req: ListOffsetsCall): unknown => {
		const ts = req.topics[0]?.partitions[0]?.timestamp;
		const offset = ts === ListOffsetTimestamps.EARLIEST ? spec.earliest : spec.latest;
		return [{ name: spec.name, partitions: [{ partitionIndex: spec.partitionIndex, timestamp: ts, offset }] }];
	};
}

function buildClientManager(opts: { listOffsets: (req: ListOffsetsCall) => unknown; createConsumer?: () => unknown }) {
	const tracker = { createConsumerCalls: 0 };
	const fakeAdmin = {
		listOffsets: mock(async (req: ListOffsetsCall) => opts.listOffsets(req)),
	} as unknown as Admin;
	const manager = {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
		createConsumer: async () => {
			tracker.createConsumerCalls++;
			if (!opts.createConsumer) throw new Error("createConsumer not expected in this test");
			return opts.createConsumer();
		},
	} as unknown as KafkaClientManager;
	return { manager, tracker, listOffsetsMock: fakeAdmin.listOffsets as unknown as ReturnType<typeof mock> };
}

describe("KafkaService.getMessageByOffset", () => {
	test("returns out_of_range when offset < earliest, without creating a consumer", async () => {
		const env = buildClientManager({
			listOffsets: bounds({ name: "sap-car-prices-dlt", partitionIndex: 0, earliest: 100n, latest: 1000n }),
		});
		const service = new KafkaService(env.manager);

		const result = await service.getMessageByOffset("sap-car-prices-dlt", 0, 50);

		expect(result.status).toBe("out_of_range");
		if (result.status !== "out_of_range") throw new Error("type narrowing");
		expect(result.requestedOffset).toBe("50");
		expect(result.earliestOffset).toBe("100");
		expect(result.latestOffset).toBe("1000");
		expect(result.message).toContain("retention");
		expect(env.tracker.createConsumerCalls).toBe(0);
	});

	test("returns out_of_range when offset >= latest (high watermark)", async () => {
		const env = buildClientManager({
			listOffsets: bounds({ name: "topic-a", partitionIndex: 2, earliest: 0n, latest: 500n }),
		});
		const service = new KafkaService(env.manager);

		const result = await service.getMessageByOffset("topic-a", 2, 500);

		expect(result.status).toBe("out_of_range");
		if (result.status !== "out_of_range") throw new Error("type narrowing");
		expect(result.message).toContain("high watermark");
		expect(env.tracker.createConsumerCalls).toBe(0);
	});

	test("returns PARTITION_NOT_FOUND when listOffsets returns no matching partition", async () => {
		const env = buildClientManager({
			listOffsets: () => [{ name: "topic-a", partitions: [] }],
		});
		const service = new KafkaService(env.manager);

		const result = await service.getMessageByOffset("topic-a", 0, 0);

		expect(result.status).toBe("error");
		if (result.status !== "error") throw new Error("type narrowing");
		expect(result.code).toBe("PARTITION_NOT_FOUND");
		expect(env.tracker.createConsumerCalls).toBe(0);
	});

	test("classifies broker errors thrown as MultipleErrors with kafkaErrorCode and kafkaErrorName", async () => {
		const env = buildClientManager({
			listOffsets: bounds({ name: "topic-a", partitionIndex: 0, earliest: 0n, latest: 1000n }),
			createConsumer: () => {
				const fakeChild = Object.assign(new Error("UNSUPPORTED_VERSION"), { errorCode: 35 });
				const aggregate = new MultipleErrors("Received response with error while executing API Fetch(v16)", [
					fakeChild,
				]);
				return {
					closed: false,
					consume: () => Promise.reject(aggregate),
					close: async () => {},
				};
			},
		});
		const service = new KafkaService(env.manager);

		const result = await service.getMessageByOffset("topic-a", 0, 100);

		expect(result.status).toBe("error");
		if (result.status !== "error") throw new Error("type narrowing");
		expect(result.code).toBe("BROKER_ERROR");
		expect(result.kafkaErrorCode).toBe(35);
		expect(result.kafkaErrorName).toBe("UNSUPPORTED_VERSION");
	});

	test("classifies OFFSET_OUT_OF_RANGE (1) when broker rejects fetch despite our pre-check", async () => {
		const env = buildClientManager({
			listOffsets: bounds({ name: "topic-a", partitionIndex: 0, earliest: 0n, latest: 1000n }),
			createConsumer: () => {
				const child = Object.assign(new Error("OFFSET_OUT_OF_RANGE"), { errorCode: 1 });
				const aggregate = new MultipleErrors("Received response with error while executing API Fetch(v16)", [child]);
				return {
					closed: false,
					consume: () => Promise.reject(aggregate),
					close: async () => {},
				};
			},
		});
		const service = new KafkaService(env.manager);

		const result = await service.getMessageByOffset("topic-a", 0, 500);

		expect(result.status).toBe("error");
		if (result.status !== "error") throw new Error("type narrowing");
		expect(result.kafkaErrorCode).toBe(1);
		expect(result.kafkaErrorName).toBe("OFFSET_OUT_OF_RANGE");
	});

	test("SIO-700: classifies bounds-call MultipleErrors as BROKER_ERROR instead of leaking raw message", async () => {
		// Reproduces the deployed-runtime bug where admin.listOffsets throws
		// MultipleErrors("Listing offsets failed.", ...) and the raw string surfaces as -32603.
		const env = buildClientManager({
			listOffsets: () => {
				const child = Object.assign(new Error("UNKNOWN_TOPIC_OR_PARTITION"), { errorCode: 3 });
				throw new MultipleErrors("Listing offsets failed.", [child]);
			},
		});
		const service = new KafkaService(env.manager);

		const result = await service.getMessageByOffset("topic-a", 0, 0);

		expect(result.status).toBe("error");
		if (result.status !== "error") throw new Error("type narrowing");
		expect(result.code).toBe("BROKER_ERROR");
		expect(result.kafkaErrorCode).toBe(3);
		expect(result.kafkaErrorName).toBe("UNKNOWN_TOPIC_OR_PARTITION");
		expect(env.tracker.createConsumerCalls).toBe(0);
	});

	test("SIO-700: issues two single-timestamp listOffsets calls (avoids duplicate-partitionIndex shape)", async () => {
		const env = buildClientManager({
			listOffsets: bounds({ name: "topic-a", partitionIndex: 0, earliest: 10n, latest: 100n }),
		});
		const service = new KafkaService(env.manager);

		// Query out-of-range so the call returns before reaching the consumer path.
		const result = await service.getMessageByOffset("topic-a", 0, 5);
		expect(result.status).toBe("out_of_range");

		const calls = env.listOffsetsMock.mock.calls as Array<[ListOffsetsCall]>;
		expect(calls).toHaveLength(2);
		const timestamps = calls.map((c) => c[0].topics[0]?.partitions[0]?.timestamp).sort();
		expect(timestamps).toEqual([ListOffsetTimestamps.EARLIEST, ListOffsetTimestamps.LATEST].sort());
		for (const [req] of calls) {
			expect(req.topics).toHaveLength(1);
			expect(req.topics[0]?.partitions).toHaveLength(1);
		}
	});
});
