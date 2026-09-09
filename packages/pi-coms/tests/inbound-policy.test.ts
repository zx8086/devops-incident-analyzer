// tests/inbound-policy.test.ts
import { describe, expect, test } from "bun:test";
import { decideInbound, globToRegExp, parseMutePatterns } from "../extensions/inboundPolicy";

const base = {
	senderName: "monitor-eu-oit-prd",
	mailbox: false,
	hasSchema: true,
	contextPct: 40,
	mutePatterns: [] as string[],
	refuseAbovePct: 85,
};

describe("decideInbound", () => {
	test("mailbox messages stay passive notices, even from a muted sender", () => {
		expect(decideInbound({ ...base, mailbox: true, mutePatterns: ["monitor-*"] })).toEqual({ kind: "notice" });
	});

	test("a plain prompt from an unmuted sender is a turn", () => {
		expect(decideInbound(base)).toEqual({ kind: "turn" });
	});

	test("a muted sender is refused with the matching pattern", () => {
		expect(decideInbound({ ...base, mutePatterns: ["laptop", "monitor-*"] })).toEqual({
			kind: "refuse",
			reason: "recipient muted (monitor-*)",
		});
		expect(decideInbound({ ...base, senderName: "simon", mutePatterns: ["monitor-*"] })).toEqual({ kind: "turn" });
	});

	test("schema-carrying prompts are refused above the context rail", () => {
		expect(decideInbound({ ...base, contextPct: 85 })).toEqual({
			kind: "refuse",
			reason: "recipient context at 85%, refusing investigation",
		});
		expect(decideInbound({ ...base, contextPct: 97.6 }).kind).toBe("refuse");
		expect(decideInbound({ ...base, contextPct: 84.9 })).toEqual({ kind: "turn" });
	});

	test("human prompts (no schema) always run, and an unknown percentage counts as room", () => {
		expect(decideInbound({ ...base, hasSchema: false, contextPct: 99 })).toEqual({ kind: "turn" });
		expect(decideInbound({ ...base, contextPct: null })).toEqual({ kind: "turn" });
	});
});

test("globToRegExp anchors and escapes", () => {
	expect(globToRegExp("monitor-*").test("monitor-eu-oit-prd")).toBe(true);
	expect(globToRegExp("monitor-*").test("xmonitor-eu")).toBe(false);
	expect(globToRegExp("a.b").test("axb")).toBe(false);
	expect(globToRegExp("MONITOR-?u-*").test("monitor-eu-oit")).toBe(true);
});

test("parseMutePatterns splits, trims, drops empties", () => {
	expect(parseMutePatterns(" monitor-*, laptop ,,")).toEqual(["monitor-*", "laptop"]);
	expect(parseMutePatterns(undefined)).toEqual([]);
});
