// tests/services/kafka-classify-error.test.ts
// SIO-1087: classifyKafkaError maps the Kafka protocol code onto the shared ToolErrorKind. These
// pure-function tests protect the cross-datasource confidence/retry behavior that mapping drives.
import { describe, expect, test } from "bun:test";
import { MultipleErrors, NetworkError, TimeoutError } from "@platformatic/kafka";
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

	// SIO-1447: admin operations routed through kPerformWithRetry/#findCoordinator wrap a
	// connection failure in a generic MultipleErrors with no protocol code at all -- e.g.
	// admin.js:908 `new MultipleErrors('Listing consumer group offsets failed.', [error])`.
	// The one-level apiCode/errorCode scan above never sees these; classifyKafkaError must
	// recurse into nested MultipleErrors and read the library's own GenericError.code.
	describe("SIO-1447: generic connection-failure wrappers with no protocol code", () => {
		test("live repro shape: nested MultipleErrors -> MultipleErrors -> NetworkError(cause: ECONNREFUSED) classifies as network", () => {
			// Mirrors the real call chain verified against @platformatic/kafka@2.0.1:
			// admin.js:908 wraps #findCoordinator's error, which is connection-pool.js:155's
			// 'Cannot connect to any broker.' MultipleErrors, whose child is connection.js:411's
			// NetworkError carrying the raw Node ECONNREFUSED as .cause.
			const econnrefused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9092"), {
				code: "ECONNREFUSED",
			});
			const networkErr = new NetworkError("Connection to broker:9092 failed.", { cause: econnrefused });
			const poolExhausted = new MultipleErrors("Cannot connect to any broker.", [networkErr]);
			const err = new MultipleErrors("Listing consumer group offsets failed.", [poolExhausted]);

			const c = classifyKafkaError(err);
			expect(c.kind).toBe("network");
		});

		test("NetworkError with no .cause still classifies via GenericError.code alone", () => {
			const err = new MultipleErrors("Describing groups failed.", [
				new NetworkError("Connection closed while waiting for ready."),
			]);
			expect(classifyKafkaError(err).kind).toBe("network");
		});

		test("TimeoutError classifies as a transient kind (library bug: TimeoutError.code is actually PLT_KFK_NETWORK in 2.0.1)", () => {
			// @platformatic/kafka@2.0.1's TimeoutError constructor calls
			// super(NetworkError.code, ...) instead of super(TimeoutError.code, ...), so a real
			// TimeoutError instance's .code is 'PLT_KFK_NETWORK', not 'PLT_KFK_TIMEOUT'. Classify
			// defensively on both the (buggy) .code string AND instanceof so this doesn't silently
			// regress to unknown if the upstream library fixes its own bug in a later version.
			const err = new MultipleErrors("Listing consumer group offsets failed.", [
				new TimeoutError("Connection to broker:9092 timed out."),
			]);
			const kind = classifyKafkaError(err).kind;
			expect(kind === "timeout" || kind === "network").toBe(true);
		});

		test("ECONNRESET cause classifies as network", () => {
			const econnreset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
			const err = new MultipleErrors("Describing client quotas failed.", [
				new NetworkError("Connection closed", { cause: econnreset }),
			]);
			expect(classifyKafkaError(err).kind).toBe("network");
		});

		test("ETIMEDOUT cause classifies as timeout", () => {
			const etimedout = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
			const err = new MultipleErrors("Altering client quotas failed.", [
				new NetworkError("Connection to broker:9092 failed.", { cause: etimedout }),
			]);
			expect(classifyKafkaError(err).kind).toBe("timeout");
		});

		test("protocol code still wins when both a code and a nested connection failure are present", () => {
			// Precedence check: apiCode/errorCode (existing, most specific) must still be
			// checked before falling into the new GenericError.code / .cause walk.
			const child = Object.assign(new Error("protocol error 3"), { apiCode: 3 });
			const err = new MultipleErrors("aggregate", [child, new NetworkError("unrelated network noise")]);
			expect(classifyKafkaError(err).kind).toBe("not-found");
		});

		test("a MultipleErrors with only truly uninformative children (no code, no cause) still yields kind=null", () => {
			const err = new MultipleErrors("Something failed.", [new Error("no signal here")]);
			const c = classifyKafkaError(err);
			expect(c.kind).toBeNull();
		});
	});
});
