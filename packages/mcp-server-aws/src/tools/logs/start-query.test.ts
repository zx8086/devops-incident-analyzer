// src/tools/logs/start-query.test.ts
//
// SIO-1078: aws_logs_start_query repeatedly hit MalformedQueryException when the
// query window predated a log group's retention/creation. These unit tests cover the
// two pure decision helpers that clamp or short-circuit the window before the SDK call.

import { describe, expect, test } from "bun:test";
import { decideQueryWindow, resolveQueryFloor } from "./start-query.ts";

// Fixed "now" so retention math is deterministic (no Date.now() dependence).
const NOW = 1_700_000_000; // epoch seconds
const DAY = 86_400;

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
