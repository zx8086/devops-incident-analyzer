// apps/web/src/lib/digest-emphasis.test.ts
// SIO-1720: the lines here are real, taken from a live prd digest.
import { describe, expect, test } from "bun:test";
import { emphasiseDigest } from "./digest-emphasis.ts";

describe("emphasiseDigest", () => {
	test("badges the severity and labels the family, not the resource name after it", () => {
		const line =
			"  - (critical/alarm) corrected-delivery-dates-CPU-Utilization-Low-20: Alarm corrected-delivery-dates-CPU-Utilization-Low-20 entered ALARM";
		const out = emphasiseDigest(line);
		expect(out).toContain("bg-tommy-red-ui");
		expect(out).toContain(">critical</span>");
		expect(out).toContain(">alarm</span>");
		// The point of the ticket: the 50-char resource name stays unemphasised.
		expect(out).toContain("corrected-delivery-dates-CPU-Utilization-Low-20: Alarm");
		expect(out).not.toContain("corrected-delivery-dates-CPU-Utilization-Low-20</span>");
	});

	test("bolds a summary label and keeps its value plain", () => {
		expect(emphasiseDigest("- findings: 26 (trail=3 watchlist=1)")).toBe("- **findings:** 26 (trail=3 watchlist=1)");
		expect(emphasiseDigest("- spend yesterday: $0.18 vs 14d baseline $1.19")).toBe(
			"- **spend yesterday:** $0.18 vs 14d baseline $1.19",
		);
	});

	test("covers every family seen live", () => {
		for (const [severity, family] of [
			["critical", "alarm"],
			["critical", "trail"],
			["critical", "cert"],
			["warn", "logs"],
			["warn", "ingestion"],
			["warn", "watchlist"],
			["info", "ingestion"],
			["info", "alarm"],
			["info", "logs"],
		]) {
			const out = emphasiseDigest(`- (${severity}/${family}) thing: detail`);
			expect(out).toContain(`>${severity}</span>`);
			expect(out).toContain(`>${family}</span>`);
			expect(out).toContain("thing: detail");
		}
	});

	// An unrecognised severity must not render an uncoloured badge: it falls back
	// to the old bold text so a new monitor severity is visible as unstyled.
	test("falls back to bold text for an unknown severity", () => {
		expect(emphasiseDigest("- (notice/logs) thing: detail")).toBe("- **(notice/logs)** thing: detail");
	});

	// The badge markup is built from the allowlist, so hostile monitor text stays
	// in the line as text and is sanitized downstream -- it never becomes markup.
	test("keeps monitor-authored markup out of the badge", () => {
		const out = emphasiseDigest("- (critical/alarm) <img src=x onerror=alert(1)>: boom");
		expect(out).toContain(">critical</span>");
		// The hostile span is still plain text on the line, after the badge markup.
		expect(out.slice(out.lastIndexOf("</span>"))).toContain("<img src=x");
	});

	test("leaves a resource name that contains a colon alone", () => {
		// An ARN is not a label: digits and colons must not trigger the label rule.
		const arn = "arn:aws:iam::399987695868:role/DevOpsAgentReadOnly is denied";
		expect(emphasiseDigest(arn)).toBe(arn);
	});

	test("does not double-emphasise text the monitor already bolded", () => {
		const already = "- **findings:** 26";
		expect(emphasiseDigest(already)).toBe(already);
	});

	test("leaves a plain spoke reply untouched", () => {
		const reply = "I checked the cluster and everything looks healthy.";
		expect(emphasiseDigest(reply)).toBe(reply);
	});

	test("preserves list markers and indentation", () => {
		expect(emphasiseDigest("    - (warn/logs) x: y")).toStartWith("    - <span");
		expect(emphasiseDigest("2. (info/alarm) x: y")).toStartWith("2. <span");
	});

	test("ignores a parenthetical that is not at the head of the line", () => {
		const mid = "the alarm (critical/alarm) fired twice";
		expect(emphasiseDigest(mid)).toBe(mid);
	});

	test("handles empty and whitespace input", () => {
		expect(emphasiseDigest("")).toBe("");
		expect(emphasiseDigest("\n\n")).toBe("\n\n");
	});

	test("emphasises the digest header's own summary lines end to end", () => {
		const digest = [
			"[info] aws-399987695868 daily digest (since 2026-09-11T00:00:21.088Z)",
			"",
			"- findings: 26 (trail=3 alarm=19)",
			"- notable warn+ findings (last 24h):",
			"  - (critical/trail) aws-controltower-BaselineCloudTrail: CloudTrail is NOT logging",
			"- alarms: none in ALARM",
		].join("\n");
		const out = emphasiseDigest(digest).split("\n");
		expect(out[2]).toBe("- **findings:** 26 (trail=3 alarm=19)");
		expect(out[4]).toContain(">critical</span>");
		expect(out[4]).toContain(">trail</span>");
		expect(out[5]).toBe("- **alarms:** none in ALARM");
		// The bracketed severity header is not a label and is left as written.
		expect(out[0]).toBe("[info] aws-399987695868 daily digest (since 2026-09-11T00:00:21.088Z)");
	});
});
