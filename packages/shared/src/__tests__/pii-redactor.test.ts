// shared/src/__tests__/pii-redactor.test.ts
import { afterEach, describe, expect, test } from "bun:test";
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

	// Phone regex must require a separator so bare 10-digit IDs (Elasticsearch
	// node suffixes, sequence IDs) survive token-by-token streaming where chunk
	// boundaries would otherwise satisfy a lookbehind.
	test("does not redact bare 10-digit identifiers", () => {
		expect(redactPiiContent("node-0000000088")).toBe("node-0000000088");
		expect(redactPiiContent("instance-0000000147 (73 KB free)")).toBe("instance-0000000147 (73 KB free)");
		expect(redactPiiContent("3102818847")).toBe("3102818847");
		expect(redactPiiContent(" 0000000099 ")).toBe(" 0000000099 ");
	});

	test("does not redact bare digits split across streamed chunks", () => {
		const chunks = ["Master node-", "0000000088", " JVM"];
		const joined = chunks.map(redactPiiContent).join("");
		expect(joined).toBe("Master node-0000000088 JVM");
	});

	test("passes through text with no PII unchanged", () => {
		const input = "Kafka consumer lag is 5000 messages behind on topic orders.created";
		expect(redactPiiContent(input)).toBe(input);
	});
});

describe("redactPiiContent with PII_REDACTION_ALLOWED_DOMAINS", () => {
	const originalValue = process.env.PII_REDACTION_ALLOWED_DOMAINS;

	afterEach(() => {
		if (originalValue === undefined) {
			delete process.env.PII_REDACTION_ALLOWED_DOMAINS;
		} else {
			process.env.PII_REDACTION_ALLOWED_DOMAINS = originalValue;
		}
	});

	test("preserves emails matching an allowlisted domain", () => {
		process.env.PII_REDACTION_ALLOWED_DOMAINS = "pvh.com";
		expect(redactPiiContent("assignee: edaengineering@pvh.com")).toBe("assignee: edaengineering@pvh.com");
	});

	test("preserves emails matching a subdomain of an allowlisted domain", () => {
		process.env.PII_REDACTION_ALLOWED_DOMAINS = "pvh.com";
		expect(redactPiiContent("ping team@corp.pvh.com")).toBe("ping team@corp.pvh.com");
	});

	test("still redacts emails outside the allowlist when one is configured", () => {
		process.env.PII_REDACTION_ALLOWED_DOMAINS = "pvh.com";
		const input = "internal team@pvh.com messaged customer@example.com";
		const result = redactPiiContent(input);
		expect(result).toContain("team@pvh.com");
		expect(result).toContain("[EMAIL_REDACTED]");
		expect(result).not.toContain("customer@example.com");
	});

	test("handles multiple allowlisted domains", () => {
		process.env.PII_REDACTION_ALLOWED_DOMAINS = "pvh.com, tommy.com ";
		const input = "a@pvh.com and b@tommy.com and c@outsider.io";
		const result = redactPiiContent(input);
		expect(result).toContain("a@pvh.com");
		expect(result).toContain("b@tommy.com");
		expect(result).toContain("[EMAIL_REDACTED]");
		expect(result).not.toContain("outsider.io");
	});

	test("allowlist does not interfere with other PII redaction", () => {
		process.env.PII_REDACTION_ALLOWED_DOMAINS = "pvh.com";
		const input = "ops@pvh.com escalated from 192.168.1.5 -- SSN 123-45-6789";
		const result = redactPiiContent(input);
		expect(result).toContain("ops@pvh.com");
		expect(result).toContain("[IP_REDACTED]");
		expect(result).toContain("[SSN_REDACTED]");
	});

	test("empty or unset allowlist leaves all-email redaction behavior intact", () => {
		process.env.PII_REDACTION_ALLOWED_DOMAINS = "";
		expect(redactPiiContent("user@pvh.com")).toBe("[EMAIL_REDACTED]");
		delete process.env.PII_REDACTION_ALLOWED_DOMAINS;
		expect(redactPiiContent("user@pvh.com")).toBe("[EMAIL_REDACTED]");
	});
});
