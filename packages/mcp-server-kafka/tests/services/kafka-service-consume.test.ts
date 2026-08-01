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

		expect(result.messages).toEqual([]);
		expect(result.timedOut).toBe(true);
		expect(stream.closed).toBe(true);
		expect(consumerClosed).toBe(true);
		// Bound checks: should fire roughly at timeoutMs, not hang indefinitely.
		expect(elapsed).toBeGreaterThanOrEqual(150);
		expect(elapsed).toBeLessThan(2000);
	});

	// SIO-734: ephemeral mcp-consume-<uuid> groups must be closed on every exit
	// path, not just the happy path / timer path. Without these tests, a regression
	// to the SIO-699 try/finally structure could leak consumer groups into MSK
	// where they accumulate as dead groups visible in list_consumer_groups.
	test("SIO-734: consumer.close() fires when consume() rejects", async () => {
		let consumerClosed = false;
		const manager = buildClientManager(() => ({
			closed: false,
			consume: async () => {
				throw new Error("broker rejected the subscribe request");
			},
			close: async () => {
				consumerClosed = true;
			},
		}));
		const service = new KafkaService(manager);

		await expect(
			service.consumeMessages({
				topic: "topic-a",
				maxMessages: 10,
				timeoutMs: 5_000,
				fromBeginning: false,
			}),
		).rejects.toThrow("broker rejected the subscribe request");

		expect(consumerClosed).toBe(true);
	});

	test("SIO-734: consumer.close() fires when the iterator throws mid-stream", async () => {
		const throwingStream: FakeStream = {
			closed: false,
			close: async () => {
				throwingStream.closed = true;
			},
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					throw new Error("connection lost mid-fetch");
				},
			}),
		};
		let consumerClosed = false;
		const manager = buildClientManager(() => ({
			closed: false,
			consume: async () => throwingStream,
			close: async () => {
				consumerClosed = true;
			},
		}));
		const service = new KafkaService(manager);

		await expect(
			service.consumeMessages({
				topic: "topic-a",
				maxMessages: 10,
				timeoutMs: 5_000,
				fromBeginning: false,
			}),
		).rejects.toThrow("connection lost mid-fetch");

		expect(throwingStream.closed).toBe(true);
		expect(consumerClosed).toBe(true);
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

		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]?.offset).toBe("1");
		expect(result.messages[1]?.offset).toBe("2");
		expect(result.timedOut).toBe(false);
		// Should resolve well before timeoutMs since we hit maxMessages first.
		expect(elapsed).toBeLessThan(1000);
		expect(stream.closed).toBe(true);
	});

	// SIO-1335: the caller needs to tell "cut short by timeoutMs" apart from
	// "hit maxMessages" apart from "genuinely drained the topic" -- timedOut is the
	// signal a bare messages[] never carried.
	test("SIO-1335: timedOut is true when the timer fires before maxMessages is reached", async () => {
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
		];
		// Yields one message immediately, then hangs -- forcing the timer to fire
		// before maxMessages (10) is ever reached.
		let resolveNext: ((v: IteratorResult<unknown>) => void) | null = null;
		let yielded = false;
		const stream: FakeStream = {
			closed: false,
			close: async () => {
				stream.closed = true;
				resolveNext?.({ value: undefined, done: true });
				resolveNext = null;
			},
			[Symbol.asyncIterator]: () => ({
				next: () => {
					if (!yielded) {
						yielded = true;
						return Promise.resolve({ value: fakeMessages[0], done: false });
					}
					return new Promise<IteratorResult<unknown>>((resolve) => {
						if (stream.closed) resolve({ value: undefined, done: true });
						else resolveNext = resolve;
					});
				},
			}),
		};
		const manager = buildClientManager(() => ({
			closed: false,
			consume: async () => stream,
			close: async () => {},
		}));
		const service = new KafkaService(manager);

		const result = await service.consumeMessages({
			topic: "topic-a",
			maxMessages: 10,
			timeoutMs: 200,
			fromBeginning: false,
		});

		expect(result.messages).toHaveLength(1);
		expect(result.timedOut).toBe(true);
	});
});

// SIO-1159: values that are not valid UTF-8 text (Avro/Protobuf payloads) decode to
// mojibake via Buffer.toString(). Label them valueLooksBinary:true so the caller
// knows the payload is binary rather than concluding the topic is unreadable.
describe("KafkaService.consumeMessages SIO-1159 valueLooksBinary", () => {
	function fakeMsg(value: Buffer) {
		return {
			topic: "topic-a",
			partition: 0,
			offset: 42n,
			key: null,
			value,
			timestamp: 0n,
			headers: new Map(),
		};
	}

	async function consumeOne(value: Buffer) {
		const stream = buildYieldingStream([fakeMsg(value)]);
		const manager = buildClientManager(() => ({
			closed: false,
			consume: async () => stream,
			close: async () => {},
		}));
		const service = new KafkaService(manager);
		const { messages } = await service.consumeMessages({
			topic: "topic-a",
			maxMessages: 1,
			timeoutMs: 5_000,
			fromBeginning: true,
		});
		return messages[0];
	}

	test("an Avro-style binary payload is flagged", async () => {
		// Magic byte + schema id + random high bytes: decodes to replacement chars.
		const binary = Buffer.from([0x00, 0x00, 0x00, 0x01, 0xc3, 0x28, 0xa0, 0xa1, 0x80, 0x81, 0xfe, 0xff, 0x00, 0x9f]);
		const msg = await consumeOne(binary);
		expect(msg?.valueLooksBinary).toBe(true);
	});

	test("a JSON text payload is not flagged", async () => {
		const msg = await consumeOne(Buffer.from(JSON.stringify({ id: null, soldToNumber: "0000000000" })));
		expect(msg?.valueLooksBinary).toBeUndefined();
		expect(msg?.value).toContain("soldToNumber");
	});
});
