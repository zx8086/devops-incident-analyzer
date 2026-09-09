// tests/monitor-history.test.ts
import { describe, expect, test } from "bun:test";
import { formatHistory, HISTORY_USAGE, parseHistoryArgs } from "../scripts/monitor/history.ts";

const row = (i: number, severity: string, family = "drift") => ({
	ts: `2026-09-09T00:${String(i).padStart(2, "0")}:00.000Z`,
	payload: JSON.stringify({
		family,
		severity,
		resource: `r${i}`,
		summary: `finding ${i}`,
		dedup_key: `${family}:r${i}`,
		evidence: {},
		at: "2026-09-09T00:00:00.000Z",
		diagnosis: null,
	}),
});

describe("parseHistoryArgs", () => {
	test("defaults, then count, severity and family in any order", () => {
		expect(parseHistoryArgs("")).toEqual({ count: 20, minSeverity: null, family: null });
		expect(parseHistoryArgs("50 warn drift")).toEqual({ count: 50, minSeverity: "warn", family: "drift" });
		expect(parseHistoryArgs("Critical alarm 5")).toEqual({ count: 5, minSeverity: "critical", family: "alarm" });
	});

	test("rejects zero, over-cap counts and unknown words with the usage line", () => {
		expect(parseHistoryArgs("0")).toEqual({ error: HISTORY_USAGE });
		expect(parseHistoryArgs("201")).toEqual({ error: HISTORY_USAGE });
		expect(parseHistoryArgs("full")).toEqual({ error: HISTORY_USAGE });
	});
});

describe("formatHistory", () => {
	const rows = [row(1, "info"), row(2, "warn"), row(3, "critical"), row(4, "warn", "alarm"), row(5, "info", "logs")];

	test("no filter keeps every row, newest count, oldest first", () => {
		const out = formatHistory(rows, { count: 2, minSeverity: null, family: null });
		expect(out.split("\n")[0]).toContain("finding 4");
		expect(out.split("\n")[1]).toContain("finding 5");
		expect(out).toContain("showing the newest 2 of 5");
	});

	test("minimum severity includes the higher levels; family narrows", () => {
		const warn = formatHistory(rows, { count: 20, minSeverity: "warn", family: null });
		expect(warn).toContain("finding 2");
		expect(warn).toContain("finding 3");
		expect(warn).toContain("finding 4");
		expect(warn).not.toContain("finding 1");
		const drift = formatHistory(rows, { count: 20, minSeverity: "warn", family: "drift" });
		expect(drift).not.toContain("finding 4");
		expect(drift).not.toContain("showing the newest");
	});

	test("empty result names the filter", () => {
		expect(formatHistory(rows, { count: 20, minSeverity: "critical", family: "logs" })).toBe(
			"no critical+ logs findings in the last 7 days",
		);
		expect(formatHistory([], { count: 20, minSeverity: null, family: null })).toBe("no findings in the last 7 days");
	});
});
