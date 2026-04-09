// shared/src/__tests__/retention.test.ts
import { describe, expect, test } from "bun:test";
import { getRetentionExpiresAt, parseRetentionPeriod } from "../retention.ts";

describe("parseRetentionPeriod", () => {
	test("parses days", () => {
		expect(parseRetentionPeriod("30d")).toBe(30 * 86_400_000);
	});

	test("parses weeks", () => {
		expect(parseRetentionPeriod("2w")).toBe(2 * 604_800_000);
	});

	test("parses months", () => {
		expect(parseRetentionPeriod("6m")).toBe(6 * 2_592_000_000);
	});

	test("parses years", () => {
		expect(parseRetentionPeriod("1y")).toBe(31_536_000_000);
	});

	test("throws on invalid format", () => {
		expect(() => parseRetentionPeriod("abc")).toThrow("Invalid retention period format");
		expect(() => parseRetentionPeriod("10h")).toThrow("Invalid retention period format");
		expect(() => parseRetentionPeriod("")).toThrow("Invalid retention period format");
	});
});

describe("getRetentionExpiresAt", () => {
	test("returns ISO timestamp in the future", () => {
		const now = new Date("2026-01-01T00:00:00Z");
		const result = getRetentionExpiresAt("1y", now);
		expect(result).toBe("2027-01-01T00:00:00.000Z");
	});

	test("handles 30-day periods", () => {
		const now = new Date("2026-06-01T12:00:00Z");
		const result = getRetentionExpiresAt("30d", now);
		const expected = new Date(now.getTime() + 30 * 86_400_000).toISOString();
		expect(result).toBe(expected);
	});
});
