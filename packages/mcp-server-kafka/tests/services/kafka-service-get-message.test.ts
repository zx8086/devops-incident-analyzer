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
	return { manager, tracker };
}

describe("KafkaService.getMessageByOffset", () => {
	test("returns out_of_range when offset < earliest, without creating a consumer", async () => {
		const env = buildClientManager({
			listOffsets: () => [
				{
					name: "sap-car-prices-dlt",
					partitions: [
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.EARLIEST, offset: 100n },
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.LATEST, offset: 1000n },
					],
				},
			],
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
			listOffsets: () => [
				{
					name: "topic-a",
					partitions: [
						{ partitionIndex: 2, timestamp: ListOffsetTimestamps.EARLIEST, offset: 0n },
						{ partitionIndex: 2, timestamp: ListOffsetTimestamps.LATEST, offset: 500n },
					],
				},
			],
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
			listOffsets: () => [
				{
					name: "topic-a",
					partitions: [
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.EARLIEST, offset: 0n },
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.LATEST, offset: 1000n },
					],
				},
			],
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
			listOffsets: () => [
				{
					name: "topic-a",
					partitions: [
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.EARLIEST, offset: 0n },
						{ partitionIndex: 0, timestamp: ListOffsetTimestamps.LATEST, offset: 1000n },
					],
				},
			],
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
});
