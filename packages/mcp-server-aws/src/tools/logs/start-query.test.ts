// src/tools/logs/start-query.test.ts
//
// SIO-1091: the query window is RELATIVE by default; the LLM no longer computes an absolute epoch,
// so the year-drift / isReal / retention-floor harness is gone. These tests cover the relative
// window resolution and the thin, non-gating retention-clamp helpers that remain.

import { describe, expect, test } from "bun:test";
import { logGroupNameFromArn, matchesTarget, parseRelative, resolveQueryFloor, resolveWindow } from "./start-query.ts";

// Fixed "now" so math is deterministic (no Date.now() dependence).
const NOW = 1_700_000_000; // epoch seconds
const DAY = 86_400;

// SIO-1091: relative-token parsing turns "now"/"now-<n><unit>" into epoch seconds against now.
describe("parseRelative (SIO-1091)", () => {
	test('bare "now" is now', () => {
		expect(parseRelative("now", NOW)).toBe(NOW);
	});

	test('"now-30d" is 30 days back', () => {
		expect(parseRelative("now-30d", NOW)).toBe(NOW - 30 * DAY);
	});

	test("supports s/m/h/d/w units", () => {
		expect(parseRelative("now-45s", NOW)).toBe(NOW - 45);
		expect(parseRelative("now-15m", NOW)).toBe(NOW - 15 * 60);
		expect(parseRelative("now-6h", NOW)).toBe(NOW - 6 * 3_600);
		expect(parseRelative("now-2w", NOW)).toBe(NOW - 2 * 604_800);
	});

	test("tolerates surrounding whitespace", () => {
		expect(parseRelative("  now-1d ", NOW)).toBe(NOW - DAY);
	});

	test("unparseable token -> null (caller falls back to default)", () => {
		expect(parseRelative("yesterday", NOW)).toBeNull();
		expect(parseRelative("now+1d", NOW)).toBeNull();
		expect(parseRelative("now-1y", NOW)).toBeNull(); // years intentionally unsupported
	});
});

// SIO-1091: absolute epochs win when provided; otherwise the relative tokens are used, defaulting
// to a wide now-30d..now window. The year cannot drift because the epoch is computed server-side.
describe("resolveWindow (SIO-1091)", () => {
	test("no inputs -> wide default now-30d..now", () => {
		const w = resolveWindow({}, NOW);
		expect(w.startTime).toBe(NOW - 30 * DAY);
		expect(w.endTime).toBe(NOW);
	});

	test("relative tokens resolve against now", () => {
		const w = resolveWindow({ startRelative: "now-6h", endRelative: "now" }, NOW);
		expect(w.startTime).toBe(NOW - 6 * 3_600);
		expect(w.endTime).toBe(NOW);
	});

	test("absolute epochs override relative", () => {
		const w = resolveWindow({ startTime: 1_699_000_000, endTime: 1_699_500_000, startRelative: "now-30d" }, NOW);
		expect(w.startTime).toBe(1_699_000_000);
		expect(w.endTime).toBe(1_699_500_000);
	});

	test("bad relative token falls back to the wide default, never a mis-dated epoch", () => {
		const w = resolveWindow({ startRelative: "2025-07-11", endRelative: "garbage" }, NOW);
		expect(w.startTime).toBe(NOW - 30 * DAY);
		expect(w.endTime).toBe(NOW);
	});
});

describe("resolveQueryFloor (retention clamp)", () => {
	test("retention-only floor: now - retentionInDays days", () => {
		const floor = resolveQueryFloor([{ retentionInDays: 30 }], NOW);
		expect(floor).toBe(NOW - 30 * DAY);
	});

	test("creation-only floor: creationTime (ms) normalized to seconds", () => {
		const created = NOW - 10 * DAY;
		const floor = resolveQueryFloor([{ creationTime: created * 1000 }], NOW);
		expect(floor).toBe(created);
	});

	test("both present: the more-restrictive (max) wins", () => {
		const created = NOW - 10 * DAY;
		const floor = resolveQueryFloor([{ retentionInDays: 90, creationTime: created * 1000 }], NOW);
		expect(floor).toBe(created);
	});

	test("missing retentionInDays = never-expire (unbounded)", () => {
		expect(resolveQueryFloor([{}], NOW)).toBe(Number.NEGATIVE_INFINITY);
	});

	test("multi-group: the most-restrictive (max) floor across groups wins", () => {
		const floor = resolveQueryFloor([{ retentionInDays: 90 }, { retentionInDays: 7 }], NOW);
		expect(floor).toBe(NOW - 7 * DAY);
	});

	test("empty groups list = unbounded (no floor known)", () => {
		expect(resolveQueryFloor([], NOW)).toBe(Number.NEGATIVE_INFINITY);
	});
});

// A CloudWatch log-group ARN from DescribeLogGroups carries a trailing ":*" and the group name may
// contain slashes; extraction must not use the last colon segment, and ARN equality must be suffixless.
describe("logGroupNameFromArn", () => {
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

// Exact-target matching against a DescribeLogGroups row. Name targets must not match prefix siblings;
// ARN targets must match ONLY by ARN (not by a same log-group name in a linked account).
describe("matchesTarget", () => {
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
		expect(matchesTarget({ logGroupName: name, arn: `${otherAcct}${name}:*` }, `${region}${name}`, false)).toBe(false);
	});

	test("ARN target with neither arn nor logGroupArn -> no match", () => {
		expect(matchesTarget({ logGroupName: name }, `${region}${name}`, false)).toBe(false);
	});
});
