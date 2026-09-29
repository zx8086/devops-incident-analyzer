// apps/web/src/lib/learning-review-pane.test.ts
import { describe, expect, test } from "bun:test";
import {
	applyReviewResponse,
	canApprove,
	describeTaskSuccess,
	isTerminal,
	type ReviewRowView,
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
		expect(canApprove(row({ taskSuccess: "1", status: "approved" }))).toBe(false);
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
		const out = applyReviewResponse(rows, "lag-corr", {
			ok: false,
			httpStatus: 409,
			error: "no confirmed task_success",
		});
		expect(out[0]).toMatchObject({ status: "candidate", message: "409: no confirmed task_success" });
		expect(out[1]?.message).toBeUndefined();
	});

	test("a success moves the state and reports the PR", () => {
		const out = applyReviewResponse([row({ taskSuccess: "1" })], "lag-corr", {
			ok: true,
			status: "approved",
			prStatus: "opened",
			prUrl: "https://github.com/o/r/pull/9",
		});
		expect(out[0]).toMatchObject({ status: "approved", message: "PR opened: https://github.com/o/r/pull/9" });
		const skipped = applyReviewResponse([row()], "lag-corr", {
			ok: true,
			status: "approved",
			prStatus: "skipped",
			prReason: "MEMORY_PR_ENABLED is not set",
		});
		expect(skipped[0]?.message).toBe("PR skipped (MEMORY_PR_ENABLED is not set)");
		const rejected = applyReviewResponse([row()], "lag-corr", { ok: true, status: "rejected" });
		expect(rejected[0]?.message).toBe("now rejected");
	});
});
