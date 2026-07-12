// src/tools/logs/start-query.test.ts
//
// SIO-1078: aws_logs_start_query repeatedly hit MalformedQueryException when the
// query window predated a log group's retention/creation. These unit tests cover the
// two pure decision helpers that clamp or short-circuit the window before the SDK call.

import { describe, expect, test } from "bun:test";
import { correctYearDrift, decideQueryWindow, resolveQueryFloor } from "./start-query.ts";

// Fixed "now" so retention math is deterministic (no Date.now() dependence).
const NOW = 1_700_000_000; // epoch seconds
const DAY = 86_400;

// Helper: epoch seconds for a UTC calendar moment.
function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
	return Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000);
}

describe("resolveQueryFloor (SIO-1078)", () => {
	test("retention-only floor: now - retentionInDays days", () => {
		const floor = resolveQueryFloor([{ retentionInDays: 30 }], NOW);
		expect(floor).toBe(NOW - 30 * DAY);
	});

	test("creation-only floor: creationTime when no retention", () => {
		const created = NOW - 10 * DAY;
		// creationTime from the SDK is epoch MILLISECONDS; the helper normalizes to seconds.
		const floor = resolveQueryFloor([{ creationTime: created * 1000 }], NOW);
		expect(floor).toBe(created);
	});

	test("both present: the more-restrictive (max) wins", () => {
		// retention floor = now-90d; creation floor = now-10d -> creation is later (max).
		const created = NOW - 10 * DAY;
		const floor = resolveQueryFloor([{ retentionInDays: 90, creationTime: created * 1000 }], NOW);
		expect(floor).toBe(created);
	});

	test("missing retentionInDays = never-expire (unbounded), so only creation floors it", () => {
		const floor = resolveQueryFloor([{}], NOW);
		expect(floor).toBe(Number.NEGATIVE_INFINITY);
	});

	test("multi-group: the most-restrictive (max) floor across groups wins", () => {
		const floor = resolveQueryFloor([{ retentionInDays: 90 }, { retentionInDays: 7 }], NOW);
		// 7-day retention is the tighter window -> its floor (now-7d) is the max.
		expect(floor).toBe(NOW - 7 * DAY);
	});

	test("empty groups list = unbounded (no floor known)", () => {
		expect(resolveQueryFloor([], NOW)).toBe(Number.NEGATIVE_INFINITY);
	});
});

describe("decideQueryWindow (SIO-1078)", () => {
	const floor = NOW - 30 * DAY;

	test("pass: whole window inside retention", () => {
		const res = decideQueryWindow(NOW - 10 * DAY, NOW, floor);
		expect(res.action).toBe("pass");
		expect(res.startTime).toBe(NOW - 10 * DAY);
	});

	test("clamp: start predates floor but end is inside", () => {
		const res = decideQueryWindow(NOW - 60 * DAY, NOW, floor);
		expect(res.action).toBe("clamp");
		expect(res.startTime).toBe(floor);
	});

	test("reject: whole window predates retention (end before floor)", () => {
		const res = decideQueryWindow(NOW - 90 * DAY, NOW - 60 * DAY, floor);
		expect(res.action).toBe("reject");
	});

	test("unbounded floor (-Infinity) always passes", () => {
		const res = decideQueryWindow(NOW - 400 * DAY, NOW, Number.NEGATIVE_INFINITY);
		expect(res.action).toBe("pass");
	});
});

// SIO-1080: the AWS sub-agent LLM shifts the incident year back (2026 -> 2025) because its
// training prior mis-dates "now", producing a window outside retention and MalformedQueryException.
// correctYearDrift deterministically snaps a year-shifted window forward when doing so lands it
// inside the queryable range; it never touches an already-valid or genuinely-old window.
describe("correctYearDrift (SIO-1080)", () => {
	// Real-shape scenario: incident 2026-07-11T23:07:59Z, 60-day retention, "now" = 2026-07-12.
	const now2026 = utc(2026, 7, 12, 12, 0, 0);
	const floor2026 = now2026 - 60 * DAY; // ~2026-05-13

	test("1-year drift below floor -> shifts window forward one year into range (the SoldTo case)", () => {
		const start = utc(2025, 7, 11, 22, 50, 0); // model's wrong 2025 anchor
		const end = utc(2025, 7, 11, 23, 50, 0);
		const res = correctYearDrift(start, end, floor2026, now2026);
		expect(res.shiftedYears).toBe(1);
		expect(res.startTime).toBe(utc(2026, 7, 11, 22, 50, 0));
		expect(res.endTime).toBe(utc(2026, 7, 11, 23, 50, 0));
		// And the corrected window is now inside retention.
		expect(res.endTime).toBeGreaterThanOrEqual(floor2026);
	});

	test("already-valid window is returned unchanged (shiftedYears 0)", () => {
		const start = utc(2026, 7, 11, 22, 50, 0);
		const end = utc(2026, 7, 11, 23, 50, 0);
		const res = correctYearDrift(start, end, floor2026, now2026);
		expect(res.shiftedYears).toBe(0);
		expect(res.startTime).toBe(start);
		expect(res.endTime).toBe(end);
	});

	test("genuinely-old window that no year-shift can fix is left unchanged (reject path handles it)", () => {
		// A window in 2019 with only creation ~2022 -> even shifting up to 5y lands before floor.
		const start = utc(2019, 1, 1);
		const end = utc(2019, 1, 2);
		const res = correctYearDrift(start, end, floor2026, now2026);
		expect(res.shiftedYears).toBe(0);
		expect(res.startTime).toBe(start);
	});

	test("2-year drift -> shifts forward two years", () => {
		const start = utc(2024, 7, 11, 22, 50, 0);
		const end = utc(2024, 7, 11, 23, 50, 0);
		const res = correctYearDrift(start, end, floor2026, now2026);
		expect(res.shiftedYears).toBe(2);
		expect(res.startTime).toBe(utc(2026, 7, 11, 22, 50, 0));
	});

	test("leap-year Feb-29 shifts to a valid date without rolling", () => {
		// 2024 is a leap year; shifting +2 years to 2026 (non-leap) must not produce Mar-1 garbage.
		const nowMar = utc(2026, 3, 15, 12, 0, 0);
		const floorMar = nowMar - 60 * DAY;
		const start = utc(2024, 2, 29, 10, 0, 0);
		const end = utc(2024, 2, 29, 11, 0, 0);
		const res = correctYearDrift(start, end, floorMar, nowMar);
		// Feb-29-2024 + 2y -> Feb-28-2026 (clamped), still a real, in-range instant.
		expect(res.shiftedYears).toBeGreaterThanOrEqual(1);
		expect(res.startTime).toBeGreaterThanOrEqual(floorMar);
		expect(res.startTime).toBeLessThanOrEqual(nowMar);
	});

	test("does not shift when every in-range shift would push the window past now (no future-dated window)", () => {
		// The window's end IS below floor (so the loop runs), but retention is tiny and the window
		// is ~1 year back, so any shift that lifts end to/above floor also pushes it past now. The
		// guard must refuse to fabricate a future-dated window and return shiftedYears 0.
		const nowEarly = utc(2026, 1, 10, 12, 0, 0); // 2026-01-10
		const floorEarly = nowEarly - 5 * DAY; // ~2026-01-05 (5-day retention)
		const start = utc(2025, 1, 15, 0, 0, 0); // 2025-01-15
		const end = utc(2025, 1, 15, 1, 0, 0);
		expect(end).toBeLessThan(floorEarly); // precondition: loop is actually entered
		const res = correctYearDrift(start, end, floorEarly, nowEarly);
		expect(res.shiftedYears).toBe(0);
		expect(res.startTime).toBe(start);
		expect(res.endTime).toBe(end);
	});

	test("unbounded floor (-Infinity) never shifts", () => {
		const start = utc(2025, 7, 11, 22, 50, 0);
		const end = utc(2025, 7, 11, 23, 50, 0);
		const res = correctYearDrift(start, end, Number.NEGATIVE_INFINITY, now2026);
		expect(res.shiftedYears).toBe(0);
	});
});
