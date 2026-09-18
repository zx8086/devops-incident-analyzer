// packages/agent/src/incident-time.test.ts
import { describe, expect, test } from "bun:test";
import {
	applyIncidentAnchors,
	extractIncidentAnchors,
	incidentQueryWindow,
	incidentQueryWindows,
	investigationWindowFor,
	isValidTimeZone,
	wallTimeToUtcMs,
} from "./incident-time.ts";

// The query from the 2026-09-18 live run, verbatim.
const LIVE_QUERY = [
	"Investigate the issue and the offending application code:-",
	"",
	"@timestamp - Sep 17, 2026 @ 21:10:42.707",
	"service.name - feed-service",
	"message - scheduled full feed: vendor catalog feed failed",
].join("\n");

describe("extractIncidentAnchors", () => {
	// The run printed 21:10:42Z. The pi spoke found the event at 19:10:42.707 in the
	// service's own logs: Kibana renders in the viewer's zone, and the viewer was in CEST.
	test("reads the live run's Kibana timestamp in the browser's zone", () => {
		expect(extractIncidentAnchors(LIVE_QUERY, "Europe/Amsterdam")).toEqual([
			{
				raw: "Sep 17, 2026 @ 21:10:42.707",
				utc: "2026-09-17T19:10:42.707Z",
				timeZone: "Europe/Amsterdam",
				assumed: false,
			},
		]);
	});

	test("the same wall time is a different instant in winter, and west of UTC", () => {
		const winter = extractIncidentAnchors("Jan 17, 2026 @ 21:10:42.707", "Europe/Amsterdam");
		expect(winter[0]?.utc).toBe("2026-01-17T20:10:42.707Z");
		const newYork = extractIncidentAnchors("Sep 17, 2026 @ 21:10:42.707", "America/New_York");
		expect(newYork[0]?.utc).toBe("2026-09-18T01:10:42.707Z");
	});

	// No zone from the caller (an API client, an older browser bundle): UTC is a guess and
	// the anchor must say so rather than present it as fact.
	test("without a usable zone it reads UTC and marks the anchor assumed", () => {
		for (const zone of [undefined, "", "Not/AZone"]) {
			const [a] = extractIncidentAnchors(LIVE_QUERY, zone);
			expect(a).toMatchObject({ utc: "2026-09-17T21:10:42.707Z", timeZone: "UTC", assumed: true });
		}
	});

	test("a zoned ISO timestamp is already absolute: the browser zone is ignored", () => {
		expect(extractIncidentAnchors("at 2026-09-17T21:10:42.707Z it failed", "Europe/Amsterdam")[0]).toEqual({
			raw: "2026-09-17T21:10:42.707Z",
			utc: "2026-09-17T21:10:42.707Z",
			timeZone: "UTC",
			assumed: false,
		});
		expect(extractIncidentAnchors("2026-09-17T21:10:42+02:00", "America/New_York")[0]?.utc).toBe(
			"2026-09-17T19:10:42.000Z",
		);
		expect(extractIncidentAnchors("2026-09-17 21:10:42,707+0200", undefined)[0]?.utc).toBe("2026-09-17T19:10:42.707Z");
	});

	// A pasted log line carries the SERVER's clock, not the reader's. Reading it in the
	// browser zone would repeat the two-hour error in the other direction.
	test("an unzoned ISO timestamp (a pasted log line) is read as UTC and marked assumed", () => {
		expect(extractIncidentAnchors("2026-09-17 19:10:42,707 ERROR boom", "Europe/Amsterdam")[0]).toEqual({
			raw: "2026-09-17 19:10:42,707",
			utc: "2026-09-17T19:10:42.707Z",
			timeZone: "UTC",
			assumed: true,
		});
	});

	test("keeps query order, drops duplicates, and ignores what is not a timestamp", () => {
		const text = "first Sep 17, 2026 @ 21:10:42.707 then 2026-09-17T19:10:42.707Z again, then Sep 18, 2026 @ 01:00:00";
		expect(extractIncidentAnchors(text, "Europe/Amsterdam").map((a) => a.utc)).toEqual([
			"2026-09-17T19:10:42.707Z",
			"2026-09-17T23:00:00.000Z",
		]);
		expect(extractIncidentAnchors("job 1234abcd-0000-4000 failed in the last 30 min", "Europe/Amsterdam")).toEqual([]);
		expect(extractIncidentAnchors("Foo 17, 2026 @ 21:10:42 and 2026-13-40T99:00:00", "Europe/Amsterdam")).toEqual([]);
	});
});

describe("wallTimeToUtcMs across DST", () => {
	const at = (month: number, day: number, hour: number, minute = 0) =>
		new Date(
			wallTimeToUtcMs({ year: 2026, month, day, hour, minute, second: 0, ms: 0 }, "Europe/Amsterdam"),
		).toISOString();

	// 2026-10-25 03:00 CEST -> 02:00 CET. One lookup at the naive guess is an hour out on
	// the day of the change; this is why the offset is looked up twice.
	test("the hours either side of the autumn change", () => {
		expect(at(10, 25, 1, 30)).toBe("2026-10-24T23:30:00.000Z");
		expect(at(10, 25, 4, 0)).toBe("2026-10-25T03:00:00.000Z");
	});

	test("the hours either side of the spring change (2026-03-29 02:00 -> 03:00)", () => {
		expect(at(3, 29, 1, 30)).toBe("2026-03-29T00:30:00.000Z");
		expect(at(3, 29, 4, 0)).toBe("2026-03-29T02:00:00.000Z");
	});

	test("isValidTimeZone", () => {
		expect(isValidTimeZone("Europe/Amsterdam")).toBe(true);
		expect(isValidTimeZone("UTC")).toBe(true);
		expect(isValidTimeZone("Mars/Olympus")).toBe(false);
		expect(isValidTimeZone(undefined)).toBe(false);
	});
});

describe("investigationWindowFor", () => {
	const anchor = (utc: string) => ({ raw: utc, utc, timeZone: "UTC", assumed: false });

	// The run's model window was now-24h: 2026-09-17T17:49Z to 2026-09-18T17:49Z. The
	// incident was inside it by luck. Anchored, the window follows the incident instead.
	test("a day either side of the incident, never past now", () => {
		const now = new Date("2026-09-18T17:49:36.162Z");
		expect(investigationWindowFor([anchor("2026-09-17T19:10:42.707Z")], now)).toEqual({
			from: "2026-09-16T19:10:42.707Z",
			to: "2026-09-18T17:49:36.162Z",
		});
	});

	test("an incident from last week gets its own window, which now-24h excluded entirely", () => {
		const now = new Date("2026-09-18T17:49:36.162Z");
		const w = investigationWindowFor([anchor("2026-09-10T08:00:00.000Z")], now);
		expect(w).toEqual({ from: "2026-09-09T08:00:00.000Z", to: "2026-09-11T08:00:00.000Z" });
	});

	test("several anchors span from the earliest to the latest", () => {
		const now = new Date("2026-09-30T00:00:00.000Z");
		expect(
			investigationWindowFor([anchor("2026-09-17T19:00:00.000Z"), anchor("2026-09-15T23:33:00.000Z")], now),
		).toEqual({ from: "2026-09-14T23:33:00.000Z", to: "2026-09-18T19:00:00.000Z" });
	});

	test("no anchors, or one in the future, leaves the window to the normalizer", () => {
		const now = new Date("2026-09-18T00:00:00.000Z");
		expect(investigationWindowFor([], now)).toBeUndefined();
		expect(investigationWindowFor([anchor("2027-09-20T00:00:00.000Z")], now)).toBeUndefined();
	});
});

describe("incidentQueryWindow", () => {
	test("all three forms describe the same window, and the relative one never excludes a second of it", () => {
		const now = "2026-09-18T17:50:22.000Z";
		const w = incidentQueryWindow("2026-09-17T19:10:42.707Z", now);
		expect(w).toEqual({
			fromIso: "2026-09-17T17:10:42.707Z",
			toIso: "2026-09-17T20:10:42.707Z",
			fromEpochSeconds: Math.floor(Date.parse("2026-09-17T17:10:42.707Z") / 1000),
			toEpochSeconds: Math.ceil(Date.parse("2026-09-17T20:10:42.707Z") / 1000),
			fromRelative: "now-1480m",
			toRelative: "now-1299m",
		});
		if (!w) throw new Error("no window");
		// What aws_logs_start_query's parseRelative will compute from those tokens.
		const nowMs = Date.parse(now);
		expect(nowMs - 1480 * 60_000).toBeLessThanOrEqual(Date.parse(w.fromIso));
		expect(nowMs - 1299 * 60_000).toBeGreaterThanOrEqual(Date.parse(w.toIso));
	});

	test("an incident still in progress ends at now", () => {
		const w = incidentQueryWindow("2026-09-18T17:30:00.000Z", "2026-09-18T17:50:00.000Z");
		expect(w?.toIso).toBe("2026-09-18T17:50:00.000Z");
		expect(w?.toRelative).toBe("now");
		expect(w?.fromRelative).toBe("now-140m");
	});

	test("unparseable input yields no window rather than a wrong one", () => {
		expect(incidentQueryWindow("nope", "2026-09-18T17:50:00.000Z")).toBeUndefined();
		expect(incidentQueryWindow("2027-01-01T00:00:00.000Z", "2026-09-18T17:50:00.000Z")).toBeUndefined();
	});
});

// The normalizer's rule, without an LLM in the loop. `modelWindow` is what the model
// actually returned on the 2026-09-18 run: its default now-24h.
describe("applyIncidentAnchors", () => {
	const now = new Date("2026-09-18T17:49:36.162Z");
	const modelWindow = { from: "2026-09-17T17:49:36.162Z", to: "2026-09-18T17:49:36.162Z" };

	test("an explicit timestamp replaces the model's default window and is carried as the anchor", () => {
		const out = applyIncidentAnchors(
			{ severity: "high", timeWindow: modelWindow },
			LIVE_QUERY,
			"Europe/Amsterdam",
			now,
		);
		expect(out.timeWindow).toEqual({ from: "2026-09-16T19:10:42.707Z", to: "2026-09-18T17:49:36.162Z" });
		expect(out.incidentAnchors?.[0]?.utc).toBe("2026-09-17T19:10:42.707Z");
		expect(out.severity).toBe("high");
	});

	// The case the live run got right only by luck: an incident older than a day.
	test("an incident from last week is in scope, where now-24h excluded it entirely", () => {
		const out = applyIncidentAnchors(
			{ timeWindow: modelWindow },
			"failed at Sep 10, 2026 @ 10:00:00.000",
			"Europe/Amsterdam",
			now,
		);
		expect(out.timeWindow).toEqual({ from: "2026-09-09T08:00:00.000Z", to: "2026-09-11T08:00:00.000Z" });
		const at = Date.parse("2026-09-10T08:00:00.000Z");
		expect(at < Date.parse(modelWindow.from)).toBe(true);
	});

	test("a query with no absolute time keeps the model's window and gains no anchor", () => {
		const incident = { severity: "medium" as const, timeWindow: modelWindow };
		const out = applyIncidentAnchors(incident, "orders are slow in the last 30 min", "Europe/Amsterdam", now);
		expect(out).toBe(incident);
	});
});

// Greptile, PR #846, both reproduced before fixing.
describe("a timestamp that cannot exist is not an anchor", () => {
	// Date.UTC never rejects: 2026-02-31 became March 3 and would have been handed to every
	// sub-agent as the authoritative incident time, replacing the investigation window.
	test("an impossible calendar date is dropped, in every shape", () => {
		expect(extractIncidentAnchors("failed at 2026-02-31T10:00:00Z", "Europe/Amsterdam")).toEqual([]);
		expect(extractIncidentAnchors("Feb 31, 2026 @ 10:00:00.000", "Europe/Amsterdam")).toEqual([]);
		expect(extractIncidentAnchors("2026-04-31 10:00:00", "Europe/Amsterdam")).toEqual([]);
		expect(extractIncidentAnchors("2025-02-29T10:00:00Z", undefined)).toEqual([]);
	});

	test("a real leap day and a real month end still parse", () => {
		expect(extractIncidentAnchors("2028-02-29T10:00:00Z", undefined)[0]?.utc).toBe("2028-02-29T10:00:00.000Z");
		expect(extractIncidentAnchors("Jan 31, 2026 @ 23:59:59.999", "Europe/Amsterdam")[0]?.utc).toBe(
			"2026-01-31T22:59:59.999Z",
		);
	});

	// 02:30 does not exist in Amsterdam on 2026-03-29 (02:00 jumps to 03:00). It converted to
	// 01:30Z, an instant the user never wrote. The hours either side are real and must stay.
	test("a local time inside the spring-forward gap is dropped; its neighbours are kept", () => {
		expect(extractIncidentAnchors("Mar 29, 2026 @ 02:30:00.000", "Europe/Amsterdam")).toEqual([]);
		expect(extractIncidentAnchors("Mar 29, 2026 @ 01:30:00.000", "Europe/Amsterdam")[0]?.utc).toBe(
			"2026-03-29T00:30:00.000Z",
		);
		expect(extractIncidentAnchors("Mar 29, 2026 @ 03:30:00.000", "Europe/Amsterdam")[0]?.utc).toBe(
			"2026-03-29T01:30:00.000Z",
		);
		// The same wall time is real in a zone with no change that night.
		expect(extractIncidentAnchors("Mar 29, 2026 @ 02:30:00.000", "UTC")[0]?.utc).toBe("2026-03-29T02:30:00.000Z");
	});

	// The autumn hour happens twice; it exists, so it is kept rather than dropped.
	test("an ambiguous autumn time is still an anchor", () => {
		expect(extractIncidentAnchors("Oct 25, 2026 @ 02:30:00.000", "Europe/Amsterdam")).toHaveLength(1);
	});
});

describe("incidentQueryWindows: one per timestamp, not just the first", () => {
	const now = "2026-09-18T17:50:22.000Z";

	// A pasted log excerpt: lines seconds apart are one event and one window.
	test("timestamps close together merge into a single window spanning them", () => {
		const w = incidentQueryWindows(["2026-09-17T19:10:42.707Z", "2026-09-17T19:09:37.000Z"], now);
		expect(w).toHaveLength(1);
		expect(w[0]?.fromIso).toBe("2026-09-17T17:09:37.000Z");
		expect(w[0]?.toIso).toBe("2026-09-17T20:10:42.707Z");
	});

	// The case the first-anchor rule got wrong: the excerpt OPENS with an older line.
	test("an older line first in the text does not take the incident's window away", () => {
		const w = incidentQueryWindows(["2026-09-15T23:33:56.974Z", "2026-09-17T19:10:42.707Z"], now);
		expect(w.map((x) => [x.fromIso, x.toIso])).toEqual([
			["2026-09-15T21:33:56.974Z", "2026-09-16T00:33:56.974Z"],
			["2026-09-17T17:10:42.707Z", "2026-09-17T20:10:42.707Z"],
		]);
	});

	test("is capped, earliest first, and skips what cannot be parsed or is in the future", () => {
		const many = ["2026-09-01", "2026-09-03", "2026-09-05", "2026-09-07"].map((d) => `${d}T00:00:00.000Z`);
		const w = incidentQueryWindows([...many, "nope", "2027-01-01T00:00:00.000Z"], now);
		expect(w).toHaveLength(3);
		expect(w[0]?.fromIso).toBe("2026-08-31T22:00:00.000Z");
	});
});
