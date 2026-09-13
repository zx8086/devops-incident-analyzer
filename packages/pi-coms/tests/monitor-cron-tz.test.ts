// tests/monitor-cron-tz.test.ts
import { describe, expect, test } from "bun:test";

// The monitor passes { tz: PI_MONITOR_TZ } to Bun.cron (coms-net-monitor.ts).
// These pin the RUNTIME contract that makes that worth doing: bun-types still
// declares a 2-arg overload, so the option is reachable only through a cast --
// which means nothing but a test catches it if the runtime behaviour changes.
const AMS = "Europe/Amsterdam";
const at = (iso: string) => new Date(iso).getTime();
const localHHMM = (ms: number | bigint) =>
	new Date(Number(ms)).toLocaleString("en-GB", { timeZone: AMS, hour: "2-digit", minute: "2-digit" });

describe("Bun.cron tz option", () => {
	// The reason the option exists: spokes run UTC (nothing sets TZ in the
	// bootstrap), so an operator's wall-clock digest time would otherwise drift
	// an hour at each DST boundary. 2026-10-25 is the CEST -> CET transition.
	test("holds wall-clock local time across a DST boundary", () => {
		const before = Bun.cron.parse("15 8 * * *", at("2026-10-20T00:00:00Z"), { tz: AMS });
		const after = Bun.cron.parse("15 8 * * *", at("2026-10-28T00:00:00Z"), { tz: AMS });
		expect(localHHMM(before)).toBe("08:15");
		expect(localHHMM(after)).toBe("08:15");
		// Same wall clock, DIFFERENT UTC instants -- proving the zone is applied
		// rather than the spec being read as UTC and coincidentally matching.
		expect(new Date(Number(before)).toISOString().slice(11, 16)).toBe("06:15");
		expect(new Date(Number(after)).toISOString().slice(11, 16)).toBe("07:15");
	});

	// PI_MONITOR_TZ unset must leave deployed behaviour untouched: the monitor
	// passes `undefined`, which has to mean "host zone", not "throw" or "UTC".
	test("undefined options is identical to omitting them", () => {
		const now = at("2026-10-20T00:00:00Z");
		expect(String(Bun.cron.parse("@daily", now, undefined))).toBe(String(Bun.cron.parse("@daily", now)));
	});

	// Fail loud, not silently onto host time -- a typo'd zone must not ship a
	// digest at the wrong hour for a year before anyone notices.
	test("an unknown zone throws rather than falling back", () => {
		expect(() => Bun.cron.parse("15 8 * * *", Date.now(), { tz: "Europe/Nowhere" })).toThrow(TypeError);
	});
});
