// agent/src/iac/lifecycle.test.ts
import { describe, expect, test } from "bun:test";
import { classifyLiveState, type IacLifecycle, isTerminalLifecycle, lifecycleRank, lifecycleTag } from "./lifecycle.ts";

describe("classifyLiveState (SIO-1005)", () => {
	test("closed MR -> closed regardless of apply status", () => {
		expect(classifyLiveState("closed", "")).toBe("closed");
		expect(classifyLiveState("closed", "success")).toBe("closed");
	});

	test("open / unread MR -> open", () => {
		expect(classifyLiveState("opened", "")).toBe("open");
		expect(classifyLiveState("", "")).toBe("open");
	});

	test("merged + apply success -> applied (live)", () => {
		expect(classifyLiveState("merged", "success")).toBe("applied");
	});

	test("merged + apply failed or canceled -> apply-failed", () => {
		expect(classifyLiveState("merged", "failed")).toBe("apply-failed");
		expect(classifyLiveState("merged", "canceled")).toBe("apply-failed");
	});

	test("merged + apply job not yet appeared ('') -> apply-not-started (never success)", () => {
		expect(classifyLiveState("merged", "")).toBe("apply-not-started");
	});

	test("merged + apply running/pending -> apply-running", () => {
		expect(classifyLiveState("merged", "running")).toBe("apply-running");
		expect(classifyLiveState("merged", "pending")).toBe("apply-running");
		expect(classifyLiveState("merged", "created")).toBe("apply-running");
	});
});

describe("isTerminalLifecycle (SIO-1005)", () => {
	test("applied / apply-failed / closed are terminal", () => {
		expect(isTerminalLifecycle("applied")).toBe(true);
		expect(isTerminalLifecycle("apply-failed")).toBe(true);
		expect(isTerminalLifecycle("closed")).toBe(true);
	});

	test("open / apply-running / apply-not-started are NOT terminal (re-checked next sweep)", () => {
		expect(isTerminalLifecycle("open")).toBe(false);
		expect(isTerminalLifecycle("apply-running")).toBe(false);
		expect(isTerminalLifecycle("apply-not-started")).toBe(false);
	});
});

describe("lifecycleRank (SIO-1005)", () => {
	test("no lifecycle annotation (legacy proposal) ranks lowest", () => {
		expect(lifecycleRank({})).toBe(0);
		expect(lifecycleRank({ outcome: "completed" })).toBe(0);
	});

	test("reconciled terminal states outrank open/transient and the legacy proposal", () => {
		expect(lifecycleRank({ lifecycle: "applied" })).toBeGreaterThan(lifecycleRank({ lifecycle: "open" }));
		expect(lifecycleRank({ lifecycle: "apply-failed" })).toBeGreaterThan(lifecycleRank({ lifecycle: "apply-running" }));
		expect(lifecycleRank({ lifecycle: "applied" })).toBeGreaterThan(lifecycleRank({}));
	});

	test("applied is the highest rank", () => {
		const states: IacLifecycle[] = ["open", "closed", "apply-not-started", "apply-running", "apply-failed"];
		for (const s of states) {
			expect(lifecycleRank({ lifecycle: "applied" })).toBeGreaterThan(lifecycleRank({ lifecycle: s }));
		}
	});

	test("an unknown lifecycle string ranks as legacy (0)", () => {
		expect(lifecycleRank({ lifecycle: "bogus" })).toBe(0);
	});
});

describe("lifecycleTag (SIO-1005)", () => {
	test("reconciled fact shows its lifecycle", () => {
		expect(lifecycleTag({ lifecycle: "applied", outcome: "completed" })).toBe("applied");
		expect(lifecycleTag({ lifecycle: "apply-failed", outcome: "completed" })).toBe("apply-failed");
	});

	test("proposal-only fact (outcome:completed, no lifecycle) reads 'proposed', not 'completed'", () => {
		expect(lifecycleTag({ outcome: "completed" })).toBe("proposed");
	});

	test("genuinely-distinct outcomes pass through verbatim (NOT relabelled)", () => {
		expect(lifecycleTag({ outcome: "rejected" })).toBe("rejected");
		expect(lifecycleTag({ outcome: "blocked" })).toBe("blocked");
		expect(lifecycleTag({ outcome: "pipeline-failed" })).toBe("pipeline-failed");
		expect(lifecycleTag({ outcome: "declined" })).toBe("declined");
		expect(lifecycleTag({ outcome: "unsupported" })).toBe("unsupported");
	});

	test("no annotations -> empty tag", () => {
		expect(lifecycleTag({})).toBe("");
	});
});
