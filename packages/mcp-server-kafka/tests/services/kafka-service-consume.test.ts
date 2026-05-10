// tests/services/kafka-service-consume.test.ts
import { describe, expect, test } from "bun:test";
import type { Admin } from "@platformatic/kafka";
import type { KafkaClientManager } from "../../src/services/client-manager.ts";
import { KafkaService } from "../../src/services/kafka-service.ts";

interface FakeStream {
	closed: boolean;
	close: () => Promise<void>;
	[Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

interface FakeConsumer {
	closed: boolean;
	consume: () => Promise<FakeStream>;
	close: () => Promise<void>;
}

// SIO-699: simulate a stream whose iterator never yields until close() is called.
// next() returns a promise that resolves to {done:true} only when close() fires --
// matching the real-world behavior of a Kafka consumer subscribed to an empty topic.
function buildHangingStream(): FakeStream {
	let resolveNext: ((v: IteratorResult<unknown>) => void) | null = null;
	const stream: FakeStream = {
		closed: false,
		close: async () => {
			stream.closed = true;
			resolveNext?.({ value: undefined, done: true });
			resolveNext = null;
		},
		[Symbol.asyncIterator]: () => ({
			next: () =>
				new Promise<IteratorResult<unknown>>((resolve) => {
					if (stream.closed) resolve({ value: undefined, done: true });
					else resolveNext = resolve;
				}),
		}),
	};
	return stream;
}

// SIO-699: stream that yields N messages immediately then signals done.
function buildYieldingStream(messages: unknown[]): FakeStream {
	const queue = [...messages];
	const stream: FakeStream = {
		closed: false,
		close: async () => {
			stream.closed = true;
		},
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				const next = queue.shift();
				if (next === undefined) return { value: undefined, done: true };
				return { value: next, done: false };
			},
		}),
	};
	return stream;
}

function buildClientManager(consumerFactory: () => FakeConsumer) {
	const fakeAdmin = {} as unknown as Admin;
	const manager = {
		withAdmin: async <T>(fn: (admin: Admin) => Promise<T>): Promise<T> => fn(fakeAdmin),
		createConsumer: async () => consumerFactory(),
	} as unknown as KafkaClientManager;
	return manager;
}

describe("KafkaService.consumeMessages SIO-699 timeout behavior", () => {
	test("returns empty array within timeoutMs when no messages arrive", async () => {
		const stream = buildHangingStream();
		let consumerClosed = false;
		const manager = buildClientManager(() => ({
			closed: false,
			consume: async () => stream,
			close: async () => {
				consumerClosed = true;
			},
		}));
		const service = new KafkaService(manager);

		const start = Date.now();
		const result = await service.consumeMessages({
			topic: "empty-topic",
			maxMessages: 10,
			timeoutMs: 200,
			fromBeginning: false,
		});
		const elapsed = Date.now() - start;

		expect(result).toEqual([]);
		expect(stream.closed).toBe(true);
		expect(consumerClosed).toBe(true);
		// Bound checks: should fire roughly at timeoutMs, not hang indefinitely.
		expect(elapsed).toBeGreaterThanOrEqual(150);
		expect(elapsed).toBeLessThan(2000);
	});

	test("returns messages when maxMessages reached without firing the timer", async () => {
		const fakeMessages = [
			{
				topic: "topic-a",
				partition: 0,
				offset: 1n,
				key: Buffer.from("k1"),
				value: Buffer.from("v1"),
				timestamp: 1700000000000n,
				headers: new Map(),
			},
			{
				topic: "topic-a",
				partition: 0,
				offset: 2n,
				key: Buffer.from("k2"),
				value: Buffer.from("v2"),
				timestamp: 1700000000001n,
				headers: new Map(),
			},
		];
		const stream = buildYieldingStream(fakeMessages);
		const manager = buildClientManager(() => ({
			closed: false,
			consume: async () => stream,
			close: async () => {},
		}));
		const service = new KafkaService(manager);

		const start = Date.now();
		const result = await service.consumeMessages({
			topic: "topic-a",
			maxMessages: 2,
			timeoutMs: 30_000,
			fromBeginning: false,
		});
		const elapsed = Date.now() - start;

		expect(result).toHaveLength(2);
		expect(result[0]?.offset).toBe("1");
		expect(result[1]?.offset).toBe("2");
		// Should resolve well before timeoutMs since we hit maxMessages first.
		expect(elapsed).toBeLessThan(1000);
		expect(stream.closed).toBe(true);
	});
});
