// tests/tools/read-consume-empty.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "../../src/config/schemas.ts";
import type { KafkaService } from "../../src/services/kafka-service.ts";
import { consumeMessages } from "../../src/tools/read/operations.ts";

// SIO-1159: an empty consume must return an annotated object, not a bare [].
// Run 270378e0 read a bare [] from a 1M-message topic and wrongly concluded the
// serialization format was unreadable -- the real cause was the default "latest"
// start offset. The note names the actual cause and the recovery path.

const config = { kafka: { consumeMaxMessages: 10, consumeTimeoutMs: 30_000 } } as unknown as AppConfig;

function serviceReturning(messages: unknown[], timedOut = false): KafkaService {
	return { consumeMessages: mock(async () => ({ messages, timedOut })) } as unknown as KafkaService;
}

describe("consumeMessages op empty-result annotation (SIO-1159)", () => {
	test("empty latest-mode result explains the latest-offset start and names the fallbacks", async () => {
		const result = await consumeMessages(serviceReturning([]), config, { topic: "orders-events" });
		expect(Array.isArray(result)).toBe(false);
		const annotated = result as { messages: unknown[]; consumed: number; mode: string; note: string };
		expect(annotated.messages).toEqual([]);
		expect(annotated.consumed).toBe(0);
		expect(annotated.mode).toBe("latest");
		expect(annotated.note).toContain("LATEST offset");
		expect(annotated.note).toContain("fromBeginning");
		expect(annotated.note).toContain("kafka_get_message_by_offset");
	});

	test("empty fromBeginning result gets the earliest-mode note instead", async () => {
		const result = await consumeMessages(serviceReturning([]), config, {
			topic: "orders-events",
			fromBeginning: true,
		});
		const annotated = result as { mode: string; note: string };
		expect(annotated.mode).toBe("earliest");
		expect(annotated.note).toContain("kafka_describe_topic");
		expect(annotated.note).not.toContain("LATEST offset");
	});

	test("non-empty results that completed on their own keep the bare array shape (backward compat)", async () => {
		const msg = { topic: "t", partition: 0, offset: "1", key: null, value: "{}", timestamp: "0", headers: {} };
		const result = await consumeMessages(serviceReturning([msg], false), config, { topic: "t" });
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([msg]);
	});

	test("the note reflects the effective timeout (explicit param over config default)", async () => {
		const result = await consumeMessages(serviceReturning([]), config, { topic: "t", timeoutMs: 5000 });
		const annotated = result as { timeoutMs: number; note: string };
		expect(annotated.timeoutMs).toBe(5000);
		expect(annotated.note).toContain("5000ms");
	});
});

// SIO-1363: a timestamp-seeded scan gets its own "seek" mode and a note that names
// it a stronger negative than fromBeginning/latest, while still flagging the
// maxMessages/timeoutMs bound.
describe("consumeMessages op timestamp-seek annotation (SIO-1363)", () => {
	test("empty seek-mode result names the timestamp and the bounded-not-exhaustive caveat", async () => {
		const result = await consumeMessages(serviceReturning([]), config, {
			topic: "mendix-customer-assignments",
			timestamp: 1753863987855,
		});
		const annotated = result as { mode: string; note: string };
		expect(annotated.mode).toBe("seek");
		expect(annotated.note).toContain("1753863987855");
		expect(annotated.note).toContain("kafka_get_topic_offsets");
		expect(annotated.note).not.toContain("LATEST offset");
	});

	test("fromBeginning takes precedence over timestamp in mode derivation", async () => {
		const result = await consumeMessages(serviceReturning([]), config, {
			topic: "t",
			fromBeginning: true,
			timestamp: 1753863987855,
		});
		const annotated = result as { mode: string };
		expect(annotated.mode).toBe("earliest");
	});

	test("non-empty seek-mode results that completed on their own keep the bare array shape", async () => {
		const msg = { topic: "t", partition: 0, offset: "1000", key: null, value: "{}", timestamp: "0", headers: {} };
		const result = await consumeMessages(serviceReturning([msg], false), config, {
			topic: "t",
			timestamp: 1753863987855,
		});
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([msg]);
	});
});

// SIO-1335: a batch cut short by timeoutMs before reaching maxMessages is just as
// ambiguous as an empty result -- annotate it so a bounded scan (SIO-1201) can tell
// "confirmed absent in this window" apart from "cut short, unconfirmed".
describe("consumeMessages op partial-batch annotation (SIO-1335)", () => {
	test("a non-empty result under maxMessages that timed out is annotated, not a bare array", async () => {
		const msg = { topic: "t", partition: 0, offset: "1", key: null, value: "{}", timestamp: "0", headers: {} };
		const result = await consumeMessages(serviceReturning([msg], true), config, { topic: "t", maxMessages: 500 });
		expect(Array.isArray(result)).toBe(false);
		const annotated = result as { messages: unknown[]; consumed: number; mode: string; note: string };
		expect(annotated.messages).toEqual([msg]);
		expect(annotated.consumed).toBe(1);
		expect(annotated.note).toContain("partial");
		expect(annotated.note).toContain("1/500");
	});

	test("hitting maxMessages exactly stays a bare array even if timedOut is also true (race at the boundary)", async () => {
		const msg = { topic: "t", partition: 0, offset: "1", key: null, value: "{}", timestamp: "0", headers: {} };
		const result = await consumeMessages(serviceReturning([msg], true), config, { topic: "t", maxMessages: 1 });
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([msg]);
	});

	test("a non-empty result that did NOT time out (genuinely completed) stays a bare array", async () => {
		const msg = { topic: "t", partition: 0, offset: "1", key: null, value: "{}", timestamp: "0", headers: {} };
		const result = await consumeMessages(serviceReturning([msg], false), config, { topic: "t", maxMessages: 500 });
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([msg]);
	});
});
