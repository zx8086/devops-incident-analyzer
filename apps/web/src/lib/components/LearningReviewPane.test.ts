// apps/web/src/lib/components/LearningReviewPane.test.ts

// SIO-1891: SSR shape checks. Rows come through the test seam so nothing fetches.
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import type { ReviewRowView } from "$lib/learning-review-pane";
import LearningReviewPane from "./LearningReviewPane.svelte";

const rows: ReviewRowView[] = [
	{
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
		evidence: ["correlated kafka lag with elastic errors"],
		message: "409: candidate has no confirmed task_success",
	},
	{
		agent: "incident-analyzer",
		skillName: "rds-storage-full",
		kind: "runbook",
		status: "approved",
		source: "fleet",
		confidence: "0.5",
		taskSuccess: "1",
		taskSuccessSource: "fleet-verdict",
		learnedAt: "2026-09-02T00:00:00Z",
		learnedFrom: "fleet:111122223333/aws-spoke",
		title: "Free RDS storage before the instance stalls.",
		whenToUse: "When FreeStorageSpace trends to zero.",
		body: "Check autoscaling, then purge, then grow.",
		evidence: [],
	},
];

describe("LearningReviewPane", () => {
	test("renders both candidates with status, kind, source and task-success chips", () => {
		const { body } = render(LearningReviewPane, { props: { agent: "incident-analyzer", initialRows: rows } });
		expect(body).toContain("Learning review");
		expect(body).toContain("lag-corr");
		expect(body).toContain("rds-storage-full");
		expect(body).toContain("candidate");
		expect(body).toContain("approved");
		expect(body).toContain("runbook / fleet");
		expect(body).toContain("success unconfirmed");
		expect(body).toContain("success confirmed (fleet-verdict)");
		expect(body).toContain("1 evidence");
	});

	test("an empty list says so without an error", () => {
		const { body } = render(LearningReviewPane, { props: { agent: "elastic-iac", initialRows: [] } });
		expect(body).toContain("No learning candidates for this agent yet.");
		expect(body).toContain("elastic-iac");
	});
});
