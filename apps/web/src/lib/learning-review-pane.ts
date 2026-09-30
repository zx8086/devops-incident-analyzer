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
	// SIO-1896: the promotion PR's persisted outcome (opened | skipped | failed).
	promotion?: string;
	prUrl?: string;
	title: string;
	whenToUse: string;
	body: string;
	evidence: string[];
	// Set by the pane after an action: the server's reason or the PR outcome.
	message?: string;
}

export type ReviewResponse =
	| {
			ok: true;
			status: ReviewRowView["status"];
			prStatus?: string;
			prUrl?: string;
			prReason?: string;
			promotionStored?: boolean;
	  }
	| { ok: false; httpStatus: number; error: string };

// SIO-1900: the request the pane sends for an action. Only what the reviewer
// CHANGED is sent as an edit; an untouched title or body is left to the stored
// text. Sending the pre-filled values back made a candidate whose stored title
// is longer than the route's edit cap impossible to approve (400), though the
// reviewer had changed nothing. kind disambiguates a skill and a runbook of one
// name; expectedStatus is the status the row showed, so a decision stored since
// is refused, not stacked.
export function buildReviewPayload(
	agent: string,
	row: Pick<ReviewRowView, "skillName" | "kind" | "status" | "title" | "body">,
	action: "approve" | "reject" | "supersede",
	input: { title: string; body: string; supersedes: string },
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		agent,
		skillName: row.skillName,
		kind: row.kind === "runbook" ? "runbook" : "skill",
		expectedStatus: row.status,
		action,
	};
	if (action === "approve") {
		const edits: { title?: string; body?: string } = {};
		if (input.title !== row.title) edits.title = input.title;
		if (input.body !== row.body) edits.body = input.body;
		if (Object.keys(edits).length > 0) payload.edits = edits;
	}
	if (action === "supersede") payload.supersedes = input.supersedes.trim();
	return payload;
}

export function describeTaskSuccess(row: Pick<ReviewRowView, "taskSuccess" | "taskSuccessSource">): string {
	if (row.taskSuccess === "1") return `success confirmed (${row.taskSuccessSource || "unknown"})`;
	if (row.taskSuccess === "0") return `did not succeed (${row.taskSuccessSource || "unknown"})`;
	return "success unconfirmed";
}

// SIO-1896 (Codex review): an approved row may be approved again only when its
// promotion PR was skipped or failed; the server retries the PR. An opened one
// is done, a blocked one fails the same way on unchanged text, and an
// unrecorded outcome is treated as done (mirrors RETRYABLE_PROMOTIONS server side).
export function canApprove(row: Pick<ReviewRowView, "status" | "taskSuccess" | "promotion">): boolean {
	if (row.taskSuccess !== "1") return false;
	if (row.status === "candidate") return true;
	return row.status === "approved" && (row.promotion === "skipped" || row.promotion === "failed");
}

export function approveLabel(row: Pick<ReviewRowView, "status">): string {
	return row.status === "approved" ? "Retry PR" : "Approve";
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
		// Codex SIO-1896: an opened PR can still carry a warning (outcome not stored)
		const pr =
			res.prStatus === "opened" && res.prUrl
				? `PR opened: ${res.prUrl}${res.prReason ? ` (${res.prReason})` : ""}`
				: res.prStatus
					? `PR ${res.prStatus}${res.prReason ? ` (${res.prReason})` : ""}`
					: undefined;
		return {
			...row,
			status: res.status,
			// Codex SIO-1896 / Greptile #924: an outcome the server could not store gives
			// the row no promotion (a stale earlier one is cleared too), so no retry is
			// offered against a branch or PR the last attempt may have left behind.
			promotion: res.prStatus && res.promotionStored !== false ? res.prStatus : undefined,
			...(res.prUrl ? { prUrl: res.prUrl } : {}),
			message: pr ?? `now ${res.status}`,
		};
	});
}
