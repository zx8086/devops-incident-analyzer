// apps/web/src/lib/learning-review-pane.test.ts
import { describe, expect, test } from "bun:test";
import {
	applyReviewResponse,
	approveLabel,
	canApprove,
	describeTaskSuccess,
	isTerminal,
	type ReviewRowView,
	rowKey,
} from "./learning-review-pane.ts";

const row = (over: Partial<ReviewRowView> = {}): ReviewRowView => ({
	agent: "incident-analyzer",
	skillName: "lag-corr",
	kind: "skill",
	status: "candidate",
	source: "turn",
	confidence: "0.5",
	taskSuccess: "",
	taskSuccessSource: "",
	learnedAt: "2026-09-01T00:00:00Z",
	learnedFrom: "thread:t1",
	title: "Correlate lag with errors.",
	whenToUse: "When lag and errors rise together.",
	body: "Pull both series and align them.",
	evidence: ["q1"],
	...over,
});

describe("learning review pane rules (SIO-1891)", () => {
	test("approve is offered only to a candidate with confirmed task_success", () => {
		expect(canApprove(row())).toBe(false);
		expect(canApprove(row({ taskSuccess: "1" }))).toBe(true);
		// SIO-1896: an approved row retries its PR only when the promotion did not open.
		expect(canApprove(row({ taskSuccess: "1", status: "approved" }))).toBe(false);
		expect(canApprove(row({ taskSuccess: "1", status: "approved", promotion: "opened" }))).toBe(false);
		// Codex SIO-1896: blocked content fails the same way again, so no retry
		expect(canApprove(row({ taskSuccess: "1", status: "approved", promotion: "blocked" }))).toBe(false);
		expect(canApprove(row({ taskSuccess: "1", status: "approved", promotion: "failed" }))).toBe(true);
		expect(canApprove(row({ taskSuccess: "1", status: "approved", promotion: "skipped" }))).toBe(true);
		expect(approveLabel(row({ status: "approved" }))).toBe("Retry PR");
		expect(approveLabel(row())).toBe("Approve");
		expect(canApprove(row({ taskSuccess: "", status: "approved" }))).toBe(false);
		expect(isTerminal(row({ status: "superseded" }))).toBe(true);
	});

	test("task_success reads as a sentence with its source", () => {
		expect(describeTaskSuccess(row())).toBe("success unconfirmed");
		expect(describeTaskSuccess(row({ taskSuccess: "1", taskSuccessSource: "feedback" }))).toBe(
			"success confirmed (feedback)",
		);
		expect(describeTaskSuccess(row({ taskSuccess: "0", taskSuccessSource: "jev" }))).toBe("did not succeed (jev)");
	});

	test("a 409 keeps the row's state and shows the server's reason on that row only", () => {
		const rows = [row(), row({ skillName: "other" })];
		const out = applyReviewResponse(rows, row(), { ok: false, httpStatus: 409, error: "no confirmed task_success" });
		expect(out[0]).toMatchObject({ status: "candidate", message: "409: no confirmed task_success" });
		expect(out[1]?.message).toBeUndefined();
	});

	// Greptile PR #919: a skill and a runbook of one name are two rows.
	test("a response reaches only the row of its kind when names collide", () => {
		const rows = [row(), row({ kind: "runbook" })];
		const out = applyReviewResponse(rows, row({ kind: "runbook" }), { ok: true, status: "rejected" });
		expect(out[0]).toMatchObject({ kind: "skill", status: "candidate" });
		expect(out[1]).toMatchObject({ kind: "runbook", status: "rejected", message: "now rejected" });
		expect(rowKey(row())).toBe("skill:lag-corr");
	});

	test("a success moves the state and reports the PR", () => {
		const out = applyReviewResponse([row({ taskSuccess: "1" })], row(), {
			ok: true,
			status: "approved",
			prStatus: "opened",
			prUrl: "https://github.com/o/r/pull/9",
		});
		expect(out[0]).toMatchObject({
			status: "approved",
			promotion: "opened",
			prUrl: "https://github.com/o/r/pull/9",
			message: "PR opened: https://github.com/o/r/pull/9",
		});
		expect(canApprove(out[0] as ReviewRowView)).toBe(false);
		// Codex SIO-1896: an outcome the server could not store gives no promotion,
		// so no retry is offered that the server would refuse with 409.
		const unstored = applyReviewResponse([row({ taskSuccess: "1", status: "approved", promotion: "failed" })], row(), {
			ok: true,
			status: "approved",
			prStatus: "failed",
			prReason: "promotion PR failed; promotion outcome not stored",
			promotionStored: false,
		});
		expect(unstored[0]?.promotion).toBeUndefined();
		expect(canApprove(unstored[0] as ReviewRowView)).toBe(false);
		expect(unstored[0]?.message).toContain("promotion outcome not stored");
		// Codex SIO-1896: the warning is shown even when the PR itself opened
		const openedUnstored = applyReviewResponse([row({ taskSuccess: "1" })], row(), {
			ok: true,
			status: "approved",
			prStatus: "opened",
			prUrl: "https://github.com/o/r/pull/12",
			prReason: "promotion outcome not stored; the row cannot be retried from the pane",
			promotionStored: false,
		});
		expect(openedUnstored[0]?.message).toBe(
			"PR opened: https://github.com/o/r/pull/12 (promotion outcome not stored; the row cannot be retried from the pane)",
		);
		expect(openedUnstored[0]?.promotion).toBeUndefined();
		const skipped = applyReviewResponse([row()], row(), {
			ok: true,
			status: "approved",
			prStatus: "skipped",
			prReason: "MEMORY_PR_ENABLED is not set",
		});
		expect(skipped[0]?.message).toBe("PR skipped (MEMORY_PR_ENABLED is not set)");
		const rejected = applyReviewResponse([row()], row(), { ok: true, status: "rejected" });
		expect(rejected[0]?.message).toBe("now rejected");
	});
});
