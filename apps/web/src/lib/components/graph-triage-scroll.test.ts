// apps/web/src/lib/components/graph-triage-scroll.test.ts
// SIO-1812: the triage pane's follow-the-running-node decision.
import { describe, expect, test } from "bun:test";
import { runningFingerprint, shouldRevealRunning } from "./graph-triage-scroll.ts";

describe("runningFingerprint", () => {
	test("is empty when nothing is running", () => {
		expect(runningFingerprint(new Map())).toBe("");
	});

	test("follows the FIRST active node so a fan-out does not flicker", () => {
		// activeNodes is insertion-ordered, so the earliest entry is the branch that has
		// been running longest. Several parallel Sends share the pane; picking the first
		// keeps the view anchored instead of jumping between them.
		const fanOut = new Map([
			["queryDataSource", 3],
			["correlationFetch", 1],
		]);
		expect(runningFingerprint(fanOut)).toBe("queryDataSource");
	});

	test("changes when the running node changes, which is what drives the scroll", () => {
		expect(runningFingerprint(new Map([["classify", 1]]))).not.toBe(runningFingerprint(new Map([["normalize", 1]])));
	});
});

describe("shouldRevealRunning", () => {
	test("follows a new running node while the operator is at the bottom", () => {
		expect(shouldRevealRunning({ runningChanged: true, hasRunning: true, atBottom: true })).toBe(true);
	});

	// The whole point of the atBottom gate: never take the view from someone reading.
	test("leaves a reader who scrolled up alone", () => {
		expect(shouldRevealRunning({ runningChanged: true, hasRunning: true, atBottom: false })).toBe(false);
	});

	test("does not re-scroll while the same node keeps running", () => {
		expect(shouldRevealRunning({ runningChanged: false, hasRunning: true, atBottom: true })).toBe(false);
	});

	// Between nodes, and before the turn starts, there is nothing to follow -- moving the
	// view to "nothing" would yank it for no reason.
	test("does not move when nothing is running", () => {
		expect(shouldRevealRunning({ runningChanged: true, hasRunning: false, atBottom: true })).toBe(false);
	});
});
