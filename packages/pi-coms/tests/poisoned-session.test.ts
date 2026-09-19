// tests/poisoned-session.test.ts
// SIO-1817: a malformed toolUse/toolResult pair stuck in the spoke's persisted
// session made every investigation fail identically for 22 hours (eu-oit-prd,
// 2026-09-18: 9 failures at the same `messages.22` offset, zero successes).
import { describe, expect, test } from "bun:test";
import { isMalformedHistory, nextRunHealth, type RunHealth, shouldRepairHistory } from "../extensions/turnReply.ts";
import { classifyRunError, type RunErrorClass } from "../scripts/monitor/checks/spoke-health.ts";

// The live message, verbatim from journalctl on i-0eee6d21741e49a1e.
const LIVE =
	"Validation error: The number of toolResult blocks at messages.22.content exceeds the number of toolUse blocks of previous turn";

describe("isMalformedHistory", () => {
	test("recognises the live eu-oit-prd message", () => {
		expect(isMalformedHistory(LIVE)).toBe(true);
	});

	test("recognises the mirror-image pairing error", () => {
		expect(
			isMalformedHistory("Validation error: toolUse blocks at messages.4.content do not have corresponding toolResult"),
		).toBe(true);
	});

	// The whole point of the class: these must NOT trigger a history repair,
	// because compacting cannot fix them and would hide a real access problem.
	test.each([
		["access denied", "AccessDeniedException: not authorized to invoke bedrock"],
		["throttling", "ThrottlingException: Too many requests"],
		["timeout", "Request timed out after 300000ms"],
		["empty", ""],
		["undefined", undefined],
	])("does not claim %s", (_label, msg) => {
		expect(isMalformedHistory(msg)).toBe(false);
	});
});

describe("nextRunHealth tracks repeats of the SAME error", () => {
	const err = (errorMessage: string) => ({ text: "", stopReason: "error", errorMessage });

	test("three identical malformed-history errors count up", () => {
		let h: RunHealth = { consecutive_run_errors: 0 };
		for (let i = 0; i < 3; i++) h = nextRunHealth(h, err(LIVE));
		expect(h.consecutive_run_errors).toBe(3);
		expect(h.repeated_error_count).toBe(3);
	});

	// A varying error is a flaky provider, not a stuck session.
	test("three DIFFERENT errors do not accumulate a repeat count", () => {
		let h: RunHealth = { consecutive_run_errors: 0 };
		h = nextRunHealth(h, err("ThrottlingException: slow down"));
		h = nextRunHealth(h, err("AccessDeniedException: nope"));
		h = nextRunHealth(h, err("Request timed out"));
		expect(h.consecutive_run_errors).toBe(3);
		expect(h.repeated_error_count).toBe(1);
	});

	test("a success resets both counters", () => {
		let h: RunHealth = { consecutive_run_errors: 0 };
		h = nextRunHealth(h, err(LIVE));
		h = nextRunHealth(h, err(LIVE));
		h = nextRunHealth(h, { text: "ok", stopReason: "stop" });
		expect(h.consecutive_run_errors).toBe(0);
		expect(h.repeated_error_count ?? 0).toBe(0);
	});

	// SIO-1681 kept this behaviour: a local cancel is not model health.
	test("an aborted turn still passes through untouched", () => {
		const prev: RunHealth = { consecutive_run_errors: 2, last_run_error: LIVE, repeated_error_count: 2 };
		expect(nextRunHealth(prev, { text: "", stopReason: "aborted" })).toEqual(prev);
	});
});

describe("shouldRepairHistory", () => {
	test("fires on the third identical malformed-history error", () => {
		expect(shouldRepairHistory({ consecutive_run_errors: 3, last_run_error: LIVE, repeated_error_count: 3 })).toBe(
			true,
		);
	});

	test("does not fire before the threshold", () => {
		expect(shouldRepairHistory({ consecutive_run_errors: 2, last_run_error: LIVE, repeated_error_count: 2 })).toBe(
			false,
		);
	});

	// The decisive negative: a spoke genuinely locked out of Bedrock must keep
	// reporting that, not silently compact itself in a loop.
	test("never fires for a repeated ACCESS error, however many times it repeats", () => {
		expect(
			shouldRepairHistory({
				consecutive_run_errors: 9,
				last_run_error: "AccessDeniedException: not authorized",
				repeated_error_count: 9,
			}),
		).toBe(false);
	});

	test("does not fire when the same count came from different errors", () => {
		expect(shouldRepairHistory({ consecutive_run_errors: 5, last_run_error: LIVE, repeated_error_count: 1 })).toBe(
			false,
		);
	});
});

describe("classifyRunError exposes the new class", () => {
	test("the live message classifies as malformed-history, not 'other'", () => {
		expect(classifyRunError(LIVE)).toBe("malformed-history");
	});

	// Regression guard: the existing classes must keep their meaning, and
	// access-denied must still win (it is the SIO-1681 origin case).
	const cases: [string, RunErrorClass][] = [
		["AccessDeniedException 403", "access-denied"],
		["ThrottlingException: Too many requests", "throttled"],
		["Request timed out", "timeout"],
		["something else entirely", "other"],
		["", "unknown"],
	];
	test.each(cases)("%s -> %s", (msg, expected) => {
		expect(classifyRunError(msg)).toBe(expected);
	});
});
