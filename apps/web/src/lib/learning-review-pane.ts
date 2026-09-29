// apps/web/src/lib/learning-review-pane.ts

// SIO-1891: the pure rules behind LearningReviewPane.svelte, kept out of the
// component so they are unit-testable without a DOM: how a review response
// updates the row list, and what each row shows.
export interface ReviewRowView {
	agent: string;
	skillName: string;
	kind: string;
	status: "candidate" | "approved" | "rejected" | "superseded";
	source: string;
	confidence: string;
	taskSuccess: string;
	taskSuccessSource: string;
	learnedAt: string;
	learnedFrom: string;
	title: string;
	whenToUse: string;
	body: string;
	evidence: string[];
	// Set by the pane after an action: the server's reason or the PR outcome.
	message?: string;
}

export type ReviewResponse =
	| { ok: true; status: ReviewRowView["status"]; prStatus?: string; prUrl?: string; prReason?: string }
	| { ok: false; httpStatus: number; error: string };

export function describeTaskSuccess(row: Pick<ReviewRowView, "taskSuccess" | "taskSuccessSource">): string {
	if (row.taskSuccess === "1") return `success confirmed (${row.taskSuccessSource || "unknown"})`;
	if (row.taskSuccess === "0") return `did not succeed (${row.taskSuccessSource || "unknown"})`;
	return "success unconfirmed";
}

export function canApprove(row: Pick<ReviewRowView, "status" | "taskSuccess">): boolean {
	return row.status === "candidate" && row.taskSuccess === "1";
}

export function isTerminal(row: Pick<ReviewRowView, "status">): boolean {
	return row.status === "rejected" || row.status === "superseded";
}

// One row is identified by kind AND name: a skill and a runbook may share a
// name (Greptile PR #919), and they are reviewed separately.
export function rowKey(row: Pick<ReviewRowView, "kind" | "skillName">): string {
	return `${row.kind}:${row.skillName}`;
}

// Apply the server's answer to the one row it concerns. A refusal keeps the
// row's state and carries the reason; a success moves the state and reports
// the PR, if any.
export function applyReviewResponse(
	rows: ReviewRowView[],
	target: Pick<ReviewRowView, "kind" | "skillName">,
	res: ReviewResponse,
): ReviewRowView[] {
	const key = rowKey(target);
	return rows.map((row) => {
		if (rowKey(row) !== key) return row;
		if (!res.ok) return { ...row, message: `${res.httpStatus}: ${res.error}` };
		const pr =
			res.prStatus === "opened" && res.prUrl
				? `PR opened: ${res.prUrl}`
				: res.prStatus
					? `PR ${res.prStatus}${res.prReason ? ` (${res.prReason})` : ""}`
					: undefined;
		return { ...row, status: res.status, message: pr ?? `now ${res.status}` };
	});
}
