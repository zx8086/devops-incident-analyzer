// apps/web/src/lib/components/pi-fleet-scroll.test.ts
import { describe, expect, test } from "bun:test";
import { BOTTOM_SLACK_PX, isAtBottom, newestFingerprint, shouldRevealNewest } from "./pi-fleet-scroll.ts";

describe("shouldRevealNewest (SIO-1800)", () => {
	test("a new entry is always revealed, wherever the reader is (SIO-1794)", () => {
		expect(shouldRevealNewest({ countGrew: true, newestChanged: true, wasAtBottom: false })).toBe(true);
		expect(shouldRevealNewest({ countGrew: true, newestChanged: true, wasAtBottom: true })).toBe(true);
	});

	test("a reply arriving for a reader at the bottom is followed", () => {
		expect(shouldRevealNewest({ countGrew: false, newestChanged: true, wasAtBottom: true })).toBe(true);
	});

	test("a reader who scrolled up is never moved by an arriving result (SIO-1794)", () => {
		expect(shouldRevealNewest({ countGrew: false, newestChanged: true, wasAtBottom: false })).toBe(false);
	});

	test("nothing changed, nothing moves: a poll slice that patches an OLDER entry is not a reason", () => {
		expect(shouldRevealNewest({ countGrew: false, newestChanged: false, wasAtBottom: true })).toBe(false);
	});
});

describe("isAtBottom", () => {
	test("a pane that does not overflow counts as at the bottom", () => {
		expect(isAtBottom({ scrollTop: 0, clientHeight: 429, scrollHeight: 429 })).toBe(true);
	});

	// The live numbers from SIO-1800: a 429 px pane, content 562 px.
	test("the live case: at the end, within the slack, and scrolled up", () => {
		expect(isAtBottom({ scrollTop: 133, clientHeight: 429, scrollHeight: 562 })).toBe(true);
		expect(isAtBottom({ scrollTop: 133 - BOTTOM_SLACK_PX, clientHeight: 429, scrollHeight: 562 })).toBe(true);
		expect(isAtBottom({ scrollTop: 40, clientHeight: 429, scrollHeight: 562 })).toBe(false);
	});
});

describe("newestFingerprint", () => {
	const entry = (id: string, status: string, response: unknown = null, error: string | null = null) => ({
		id,
		status,
		response,
		error,
	});

	test("is empty with no entries", () => {
		expect(newestFingerprint([])).toBe("");
	});

	test("changes when the newest entry's result arrives, not when an older entry is patched", () => {
		const waiting = [entry("a", "complete", "old"), entry("b", "delivered")];
		const olderPatched = [entry("a", "error", "old", "boom"), entry("b", "delivered")];
		const answered = [entry("a", "complete", "old"), entry("b", "complete", { verdict: "confirmed" })];
		expect(newestFingerprint(olderPatched)).toBe(newestFingerprint(waiting));
		expect(newestFingerprint(answered)).not.toBe(newestFingerprint(waiting));
	});

	test("does not embed the response body", () => {
		const big = "x".repeat(10_000);
		expect(newestFingerprint([entry("a", "complete", big)]).length).toBeLessThan(40);
	});
});
