// tests/hub-reply-cap.test.ts
// SIO-1687: the hub stores replies under a byte cap. Before this, MAX_BODY_BYTES
// (1 MiB, one HTTP request) was the only bound on a reply, while the fleet
// console truncated spoke prose at 4000 chars -- so a verbose spoke spent a full
// turn producing text that was silently cut mid-sentence downstream.
import { describe, expect, test } from "bun:test";
import { capReplyBody } from "../scripts/coms-net-server.ts";

describe("capReplyBody", () => {
	test("leaves a reply that fits untouched", () => {
		const text = "3 findings\n- ecs drift on 2 services\n- no alarms";
		expect(capReplyBody(text, 65_536)).toBe(text);
	});

	test("truncates past the cap and says so", () => {
		const out = capReplyBody("x".repeat(200), 100);
		expect(out).toContain("[truncated by hub]");
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(100);
	});

	test("cap is measured in BYTES, not characters", () => {
		// Each emoji is 4 UTF-8 bytes: 50 of them exceed a 100-byte cap despite
		// being well under 100 JS string length.
		const out = capReplyBody("🙂".repeat(50), 100);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(100);
	});

	test("never splits a multi-byte code point", () => {
		for (let cap = 20; cap <= 60; cap++) {
			const out = capReplyBody("🙂".repeat(40), cap);
			// A split code point would decode to U+FFFD; none may survive.
			expect(out).not.toContain("�");
			expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(cap);
		}
	});

	test("prefers a line boundary near the end of the budget", () => {
		const line = `${"finding ".repeat(4)}\n`;
		const out = capReplyBody(line.repeat(40), 200);
		const body = out.slice(0, -"\n[truncated by hub]".length);
		expect(body.endsWith("finding")).toBe(true);
	});

	test("a zero or negative cap disables capping", () => {
		const text = "x".repeat(5_000);
		expect(capReplyBody(text, 0)).toBe(text);
		expect(capReplyBody(text, -1)).toBe(text);
	});

	// The monitor's report is one header line plus one line per finding, capped
	// at 10 findings a cycle, so the default cap never touches a real report.
	test("a full monitor report passes through the default cap intact", () => {
		const findings = Array.from(
			{ length: 10 },
			(_, i) => `- (warn/logs) log-group-${i}: 42 matches of an error signature in the last 15m`,
		).join("\n");
		const report = `[warn] aws-123456789012: 10 finding(s)\n${findings}`;
		expect(capReplyBody(report)).toBe(report);
	});
});
