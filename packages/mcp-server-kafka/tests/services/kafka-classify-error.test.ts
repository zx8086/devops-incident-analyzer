// tests/services/kafka-classify-error.test.ts
// SIO-1087: classifyKafkaError maps the Kafka protocol code onto the shared ToolErrorKind. These
// pure-function tests protect the cross-datasource confidence/retry behavior that mapping drives.
import { describe, expect, test } from "bun:test";
import { MultipleErrors } from "@platformatic/kafka";
import { classifyKafkaError, KAFKA_CODE_TO_KIND } from "../../src/services/kafka-service.ts";

// Build a MultipleErrors whose child carries a protocol code. The classifier reads `apiCode`
// (the field @platformatic/kafka's ProtocolError exposes) with an `errorCode` fallback.
function multiWithCode(code: number, field: "apiCode" | "errorCode" = "apiCode"): MultipleErrors {
	const child = Object.assign(new Error(`protocol error ${code}`), { [field]: code });
	return new MultipleErrors("aggregate", [child]);
}

describe("classifyKafkaError (SIO-1087)", () => {
	test("authorization codes -> auth-denied (non-retryable)", () => {
		for (const code of [29, 30, 31]) {
			expect(classifyKafkaError(multiWithCode(code)).kind).toBe("auth-denied");
		}
	});

	test("unknown topic/partition -> not-found", () => {
		expect(classifyKafkaError(multiWithCode(3)).kind).toBe("not-found");
		expect(classifyKafkaError(multiWithCode(100)).kind).toBe("not-found");
	});

	test("timeout/leader/network codes -> transient kinds", () => {
		expect(classifyKafkaError(multiWithCode(7)).kind).toBe("timeout");
		expect(classifyKafkaError(multiWithCode(5)).kind).toBe("network");
		expect(classifyKafkaError(multiWithCode(13)).kind).toBe("network");
	});

	test("offset-out-of-range / invalid-topic -> bad-input", () => {
		expect(classifyKafkaError(multiWithCode(1)).kind).toBe("bad-input");
		expect(classifyKafkaError(multiWithCode(17)).kind).toBe("bad-input");
	});

	test("reads the legacy errorCode field when apiCode is absent", () => {
		const c = classifyKafkaError(multiWithCode(29, "errorCode"));
		expect(c.kafkaErrorCode).toBe(29);
		expect(c.kind).toBe("auth-denied");
	});

	test("an unmapped protocol code yields kind=null (falls back to regex downstream)", () => {
		// 74 = FENCED_LEADER_EPOCH: named but intentionally NOT in KAFKA_CODE_TO_KIND.
		const c = classifyKafkaError(multiWithCode(74));
		expect(c.kafkaErrorCode).toBe(74);
		expect(c.kind).toBeNull();
	});

	test("a non-MultipleErrors error yields no code/kind", () => {
		const c = classifyKafkaError(new Error("plain error"));
		expect(c.kafkaErrorCode).toBeNull();
		expect(c.kind).toBeNull();
		expect(c.message).toBe("plain error");
	});

	test("every mapped code resolves to a defined shared kind", () => {
		for (const [code, kind] of Object.entries(KAFKA_CODE_TO_KIND)) {
			expect(classifyKafkaError(multiWithCode(Number(code))).kind).toBe(kind);
		}
	});
});
