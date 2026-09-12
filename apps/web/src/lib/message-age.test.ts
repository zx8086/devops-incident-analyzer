// apps/web/src/lib/message-age.test.ts
import { describe, expect, test } from "bun:test";
import { isNotableStatus, messageAge } from "./message-age.ts";

const NOW = Date.parse("2026-09-12T16:00:00.000Z");
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();

describe("messageAge", () => {
	test("renders minutes, hours and days", () => {
		expect(messageAge(ago(14), NOW)).toBe("14m");
		expect(messageAge(ago(59), NOW)).toBe("59m");
		expect(messageAge(ago(60), NOW)).toBe("1h");
		expect(messageAge(ago(15 * 60), NOW)).toBe("15h");
		expect(messageAge(ago(48 * 60), NOW)).toBe("2d");
	});

	test("collapses anything under a minute to 'just now'", () => {
		expect(messageAge(ago(0), NOW)).toBe("just now");
		expect(messageAge(ago(0.5), NOW)).toBe("just now");
	});

	// A hub clock slightly ahead of the browser must not render "-3m".
	test("a future timestamp reads as 'just now', never negative", () => {
		expect(messageAge(new Date(NOW + 3 * 60_000).toISOString(), NOW)).toBe("just now");
	});

	// An inbox row must never show NaN.
	test("missing or unparseable input yields an empty string", () => {
		expect(messageAge(null, NOW)).toBe("");
		expect(messageAge(undefined, NOW)).toBe("");
		expect(messageAge("", NOW)).toBe("");
		expect(messageAge("not a date", NOW)).toBe("");
	});

	// The live case: every inbox message sat at this age unlabelled.
	test("the observed 15h-old digest reads as 15h", () => {
		expect(messageAge("2026-09-12T00:00:19.277Z", Date.parse("2026-09-12T15:16:00.000Z"))).toBe("15h");
	});
});

describe("isNotableStatus", () => {
	test("the delivery lifecycle of a one-way report is not worth showing", () => {
		expect(isNotableStatus("queued")).toBe(false);
		expect(isNotableStatus("delivered")).toBe(false);
		expect(isNotableStatus("complete")).toBe(false);
	});

	test("a failure still surfaces", () => {
		expect(isNotableStatus("error")).toBe(true);
		expect(isNotableStatus("timeout")).toBe(true);
	});
});
