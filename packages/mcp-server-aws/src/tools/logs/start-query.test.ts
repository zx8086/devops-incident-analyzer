// src/tools/logs/start-query.test.ts
//
// SIO-1078: aws_logs_start_query repeatedly hit MalformedQueryException when the
// query window predated a log group's retention/creation. These unit tests cover the
// two pure decision helpers that clamp or short-circuit the window before the SDK call.

import { describe, expect, test } from "bun:test";
import {
	correctYearDrift,
	decideQueryWindow,
	getRetentionFloor,
	logGroupNameFromArn,
	matchesTarget,
	resolveFloorFromGroups,
	resolveQueryFloor,
} from "./start-query.ts";

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

// SIO-1082: the year-drift guard was gated on a per-call DescribeLogGroups; when that describe
// failed/raced/returned null the guard was skipped. The fix is cache + single-flight (so a real
// floor is available on far more calls); we deliberately do NOT synthesize a floor to DRIVE the
// correction (that would silently rewrite a legitimate historical query). isReal is true only
// when a finite floor was actually measured.
describe("resolveFloorFromGroups (SIO-1082)", () => {
	const now = utc(2026, 7, 12, 12, 0, 0);

	test("real groups -> real floor, isReal true", () => {
		const r = resolveFloorFromGroups([{ retentionInDays: 60 }], now);
		expect(r.isReal).toBe(true);
		expect(r.floor).toBe(now - 60 * DAY);
	});

	test("no groups ([] / null) -> not real, no drivable floor", () => {
		for (const g of [[], null, undefined]) {
			const r = resolveFloorFromGroups(g, now);
			expect(r.isReal).toBe(false);
			expect(r.floor).toBe(Number.NEGATIVE_INFINITY);
		}
	});

	test("non-empty rows with no usable retention/creation ([{}]) -> not real (floor is -Infinity)", () => {
		// A never-expire group with no creationTime resolves to -Infinity; it must NOT be marked
		// isReal:true (which would then skip the guard entirely under the finite check).
		const r = resolveFloorFromGroups([{}], now);
		expect(r.isReal).toBe(false);
		expect(r.floor).toBe(Number.NEGATIVE_INFINITY);
	});

	test("regression (CodeRabbit): a legitimate ~400-day-old query is NOT year-shifted when no real floor is known", () => {
		// Without a measured floor we cannot tell an LLM year-drift from a genuine historical
		// query. The caller gates correction on isReal, so the window is left untouched here.
		const { isReal } = resolveFloorFromGroups(null, now);
		expect(isReal).toBe(false); // -> caller skips correctYearDrift entirely, window unchanged
	});
});

describe("getRetentionFloor (SIO-1082 cache + single-flight)", () => {
	const now = utc(2026, 7, 12, 12, 0, 0);
	const TTL = 300_000;

	function freshCache() {
		return new Map<string, { groups: { retentionInDays?: number; creationTime?: number }[]; expiresAt: number }>();
	}

	test("cache miss describes once and caches; second call reuses (no re-describe)", async () => {
		const cache = freshCache();
		let describeCalls = 0;
		const describe = async () => {
			describeCalls++;
			return [{ retentionInDays: 60 }];
		};
		const clock = () => now * 1000;
		const a = await getRetentionFloor({ key: "eu-oit-prd:/lg", describe, nowSeconds: now, cache, ttlMs: TTL, clock });
		const b = await getRetentionFloor({ key: "eu-oit-prd:/lg", describe, nowSeconds: now, cache, ttlMs: TTL, clock });
		expect(describeCalls).toBe(1);
		expect(a.isReal).toBe(true);
		expect(b.isReal).toBe(true);
		expect(a.floor).toBe(now - 60 * DAY);
	});

	test("async describe rejection -> not real, not cached", async () => {
		const cache = freshCache();
		const describe = async () => {
			throw new Error("AccessDenied");
		};
		const r = await getRetentionFloor({
			key: "eu-oit-prd:/lg",
			describe,
			nowSeconds: now,
			cache,
			ttlMs: TTL,
			clock: () => now * 1000,
		});
		expect(r.isReal).toBe(false);
		expect(cache.size).toBe(0);
	});

	test("SYNCHRONOUS describe throw is normalized (does not escape) -> not real", async () => {
		const cache = freshCache();
		const describe = (() => {
			throw new Error("sync boom");
		}) as () => Promise<{ retentionInDays?: number }[]>;
		const r = await getRetentionFloor({
			key: "k",
			describe,
			nowSeconds: now,
			cache,
			ttlMs: TTL,
			clock: () => now * 1000,
		});
		expect(r.isReal).toBe(false);
	});

	test("single-flight: concurrent callers collapse to ONE describe", async () => {
		const cache = freshCache();
		let describeCalls = 0;
		let release: (v: { retentionInDays?: number }[]) => void = () => {};
		const gate = new Promise<{ retentionInDays?: number }[]>((res) => {
			release = res;
		});
		const describe = async () => {
			describeCalls++;
			return gate;
		};
		const opts = { key: "eu-oit-prd:/lg", describe, nowSeconds: now, cache, ttlMs: TTL, clock: () => now * 1000 };
		const p1 = getRetentionFloor(opts);
		const p2 = getRetentionFloor(opts);
		const p3 = getRetentionFloor(opts);
		release([{ retentionInDays: 45 }]);
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
		expect(describeCalls).toBe(1);
		expect(r1.floor).toBe(now - 45 * DAY);
		expect(r2.floor).toBe(r1.floor);
		expect(r3.floor).toBe(r1.floor);
	});

	test("expired cache entry triggers a fresh describe", async () => {
		const cache = freshCache();
		let describeCalls = 0;
		const describe = async () => {
			describeCalls++;
			return [{ retentionInDays: 60 }];
		};
		let t = now * 1000;
		const clock = () => t;
		await getRetentionFloor({ key: "k", describe, nowSeconds: now, cache, ttlMs: TTL, clock });
		t += TTL + 1; // advance past TTL
		await getRetentionFloor({ key: "k", describe, nowSeconds: now, cache, ttlMs: TTL, clock });
		expect(describeCalls).toBe(2);
	});
});

// SIO-1082 (CodeRabbit re-review): a CloudWatch log-group ARN from DescribeLogGroups carries a
// trailing ":*" and the group name may contain slashes; extraction must not use the last colon
// segment, and ARN equality must be suffixless.
describe("logGroupNameFromArn (SIO-1082)", () => {
	const name = "/ecs/fargate/catalog-prd-log-group";
	const region = "arn:aws:logs:eu-central-1:762715229080:log-group:";

	test("extracts the name from a plain ARN", () => {
		expect(logGroupNameFromArn(`${region}${name}`)).toBe(name);
	});

	test("extracts the name from an ARN with the trailing :* (as DescribeLogGroups returns)", () => {
		expect(logGroupNameFromArn(`${region}${name}:*`)).toBe(name);
	});

	test("handles names containing slashes (not just the last colon segment)", () => {
		expect(logGroupNameFromArn("arn:aws:logs:us-east-1:111:log-group:/a/b/c:*")).toBe("/a/b/c");
	});

	test("returns the input unchanged when it is not an ARN", () => {
		expect(logGroupNameFromArn("/plain/name")).toBe("/plain/name");
	});
});

describe("getRetentionFloor eviction (SIO-1082)", () => {
	const now = utc(2026, 7, 12, 12, 0, 0);
	const TTL = 300_000;

	test("expired entries are swept on a subsequent describe-completing call", async () => {
		const cache = new Map<string, { groups: { retentionInDays?: number }[]; expiresAt: number }>();
		let t = now * 1000;
		const clock = () => t;
		const describe = async () => [{ retentionInDays: 60 }];
		// Populate key A, then let it expire.
		await getRetentionFloor({ key: "A", describe, nowSeconds: now, cache, ttlMs: TTL, clock });
		expect(cache.has("A")).toBe(true);
		t += TTL + 1;
		// A miss on key B completes a describe and sweeps the now-expired A.
		await getRetentionFloor({ key: "B", describe, nowSeconds: now, cache, ttlMs: TTL, clock });
		expect(cache.has("A")).toBe(false);
		expect(cache.has("B")).toBe(true);
	});
});

// SIO-1082 (CodeRabbit re-review 2): exact-target matching against a DescribeLogGroups row.
// Name targets must not match prefix siblings; ARN targets must match ONLY by ARN (not by a
// same log-group name in a linked account).
describe("matchesTarget (SIO-1082)", () => {
	const region = "arn:aws:logs:eu-central-1:762715229080:log-group:";
	const otherAcct = "arn:aws:logs:eu-central-1:999999999999:log-group:";
	const name = "/ecs/fargate/catalog-prd-log-group";

	test("name target: exact name matches, prefix sibling does not", () => {
		expect(matchesTarget({ logGroupName: "/app" }, "/app", true)).toBe(true);
		expect(matchesTarget({ logGroupName: "/app-canary" }, "/app", true)).toBe(false);
	});

	test("ARN target: matches g.arn suffixlessly (API arn carries a trailing :*)", () => {
		expect(matchesTarget({ arn: `${region}${name}:*` }, `${region}${name}`, false)).toBe(true);
	});

	test("ARN target: matches the clean logGroupArn field too", () => {
		expect(matchesTarget({ logGroupArn: `${region}${name}` }, `${region}${name}:*`, false)).toBe(true);
	});

	test("ARN target: does NOT cross-match a same-named group in a different account", () => {
		// Same logGroupName, different account ARN -> must not match (the name fallback is gone).
		expect(matchesTarget({ logGroupName: name, arn: `${otherAcct}${name}:*` }, `${region}${name}`, false)).toBe(false);
	});

	test("ARN target with neither arn nor logGroupArn -> no match", () => {
		expect(matchesTarget({ logGroupName: name }, `${region}${name}`, false)).toBe(false);
	});
});
