// shared/src/__tests__/pii-redactor.test.ts
import { describe, expect, test } from "bun:test";
import { redactPiiContent } from "../pii-redactor.ts";

describe("redactPiiContent", () => {
	test("redacts email addresses", () => {
		expect(redactPiiContent("contact user@example.com for help")).toBe("contact [EMAIL_REDACTED] for help");
	});

	test("redacts IPv4 addresses", () => {
		expect(redactPiiContent("server at 192.168.1.100 is down")).toBe("server at [IP_REDACTED] is down");
	});

	test("redacts US phone numbers", () => {
		expect(redactPiiContent("call 555-123-4567")).toBe("call [PHONE_REDACTED]");
		expect(redactPiiContent("call (555) 123-4567")).toBe("call [PHONE_REDACTED]");
	});

	test("redacts SSNs", () => {
		expect(redactPiiContent("SSN: 123-45-6789")).toBe("SSN: [SSN_REDACTED]");
	});

	test("redacts credit card numbers", () => {
		expect(redactPiiContent("card 4111-1111-1111-1111")).toBe("card [CC_REDACTED]");
		expect(redactPiiContent("card 4111 1111 1111 1111")).toBe("card [CC_REDACTED]");
	});

	test("redacts multiple PII types in one string", () => {
		const input = "User user@corp.com from 10.0.0.5 called 555-867-5309";
		const result = redactPiiContent(input);
		expect(result).toContain("[EMAIL_REDACTED]");
		expect(result).toContain("[IP_REDACTED]");
		expect(result).toContain("[PHONE_REDACTED]");
		expect(result).not.toContain("user@corp.com");
		expect(result).not.toContain("10.0.0.5");
	});

	test("does not redact UUIDs", () => {
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		expect(redactPiiContent(`id: ${uuid}`)).toContain(uuid);
	});

	test("does not redact hostnames", () => {
		const input = "connected to api-gateway-prod.internal";
		expect(redactPiiContent(input)).toBe(input);
	});

	test("passes through text with no PII unchanged", () => {
		const input = "Kafka consumer lag is 5000 messages behind on topic orders.created";
		expect(redactPiiContent(input)).toBe(input);
	});
});
