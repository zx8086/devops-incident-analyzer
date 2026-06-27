// agent/src/iac/outcome.test.ts
// SIO-930: iacTurnOutcome derives the user-facing per-turn outcome from terminal state so the UI
// completion chip reflects what actually happened (rejected/declined/blocked/unsupported/failed)
// instead of an unconditional green "Completed".
import { describe, expect, test } from "bun:test";
import { iacTurnOutcome } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const s = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

describe("iacTurnOutcome (SIO-930)", () => {
	test("rejected when the plan-review gate was rejected", () => {
		expect(iacTurnOutcome(s({ reviewDecision: "rejected" }))).toBe("rejected");
	});

	test("declined when the synthetics push was declined", () => {
		expect(
			iacTurnOutcome(s({ syntheticsPushApproved: false, syntheticsDriftReport: { deployment: "x" } as never })),
		).toBe("declined");
	});

	test("declined when the fleet upgrade was declined", () => {
		expect(iacTurnOutcome(s({ fleetUpgradeApproved: false, fleetUpgradeReport: { deployment: "x" } as never }))).toBe(
			"declined",
		);
	});

	test("unsupported when blocked by a workflow:other capability message", () => {
		expect(
			iacTurnOutcome(
				s({
					blockedReason: "No proposer for this request (workflow 'other').",
					iacRequest: { workflow: "other", isProd: false },
				}),
			),
		).toBe("unsupported");
	});

	test("blocked when a guard set a blockedReason (non-other workflow)", () => {
		expect(
			iacTurnOutcome(
				s({
					blockedReason: "Cannot proceed: prod not named.",
					iacRequest: { workflow: "version-upgrade", isProd: false },
				}),
			),
		).toBe("blocked");
	});

	// SIO-1020: a no-op (requested config already matches current state) is a neutral "No change
	// needed", NOT an amber "Blocked".
	test("no-op when a proposer set a noopReason", () => {
		expect(
			iacTurnOutcome(
				s({
					noopReason: "cold tier already has the requested sizing; no change needed.",
					iacRequest: { workflow: "tier-resize", isProd: false },
				}),
			),
		).toBe("no-op");
	});

	test("a no-op outranks a (defensive) co-set blockedReason", () => {
		expect(iacTurnOutcome(s({ noopReason: "already as requested", blockedReason: "ignored" }))).toBe("no-op");
	});

	// A blockedReason on a workflow:"other" maps to "unsupported"; a no-op must still outrank that branch.
	test("a no-op outranks the unsupported (workflow:other) branch", () => {
		expect(
			iacTurnOutcome(
				s({
					noopReason: "already as requested",
					blockedReason: "No proposer for this request (workflow 'other').",
					iacRequest: { workflow: "other", isProd: false },
				}),
			),
		).toBe("no-op");
	});

	test("a human rejection still outranks a no-op", () => {
		expect(iacTurnOutcome(s({ reviewDecision: "rejected", noopReason: "already as requested" }))).toBe("rejected");
	});

	test("pipeline-failed on a terminal failed pipeline with no block/decision", () => {
		expect(iacTurnOutcome(s({ pipelineStatus: "failed" }))).toBe("pipeline-failed");
	});

	// SIO-961: a partial fleet apply rides on a CI job that exited 1 (pipelineStatus "failed"), but
	// the upgrade is in-progress with only agent-side failures -- the chip must NOT read pipeline-failed.
	test("partial fleet apply is NOT pipeline-failed even though the CI pipeline failed", () => {
		expect(iacTurnOutcome(s({ pipelineStatus: "failed", fleetUpgradeResult: { status: "partial" } as never }))).toBe(
			"completed",
		);
	});

	test("completed by default (MR opened / info answered / converse)", () => {
		expect(iacTurnOutcome(s({ mrUrl: "https://gitlab/mr/1", pipelineStatus: "success" }))).toBe("completed");
		expect(iacTurnOutcome(s({}))).toBe("completed");
	});

	test("a human rejection outranks a blockedReason", () => {
		expect(iacTurnOutcome(s({ reviewDecision: "rejected", blockedReason: "whatever" }))).toBe("rejected");
	});
});
