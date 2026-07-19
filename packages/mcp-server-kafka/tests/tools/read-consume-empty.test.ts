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

function serviceReturning(messages: unknown[]): KafkaService {
	return { consumeMessages: mock(async () => messages) } as unknown as KafkaService;
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

	test("non-empty results keep the bare array shape (backward compat)", async () => {
		const msg = { topic: "t", partition: 0, offset: "1", key: null, value: "{}", timestamp: "0", headers: {} };
		const result = await consumeMessages(serviceReturning([msg]), config, { topic: "t" });
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
