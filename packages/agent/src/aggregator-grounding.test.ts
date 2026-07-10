// packages/agent/src/aggregator-grounding.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { detectUngroundedBlockers, rewriteUngroundedBlockers } from "./aggregator.ts";

const REPORT_TAIL = `## Gaps

- ECS collector application logs (\`/ecs/fargate/open-telemetry-prd-log-group\`) are inaccessible: \`logs:DescribeLogGroups\` and \`logs:StartQuery\` are not permitted for \`DevOpsAgentReadOnly\`. OpAMP WebSocket connection state cannot be confirmed without these logs.
- Three Elasticsearch SQL queries failed during investigation (column resolution, syntax, and index errors). These were retried with alternative query forms.
- No CloudWatch metrics exist for the OTel collector's OTLP ingestion or OpAMP heartbeat.

Confidence: 0.62`;

function result(over: Partial<DataSourceResult>): DataSourceResult {
	return { dataSourceId: "aws", data: {}, status: "success", ...over };
}

describe("detectUngroundedBlockers", () => {
	test("flags an IAM-denial gap when no auth toolError was observed", () => {
		const results = [result({ dataSourceId: "aws", toolErrors: [] })];
		const { ungrounded } = detectUngroundedBlockers(REPORT_TAIL, results);
		expect(ungrounded).toHaveLength(1);
		expect(ungrounded[0]).toContain("logs:DescribeLogGroups");
	});

	test("does NOT flag when a real auth toolError exists", () => {
		const results = [
			result({
				dataSourceId: "aws",
				toolErrors: [{ toolName: "aws_logs_start_query", category: "auth", message: "AccessDenied", retryable: false }],
			}),
		];
		const { ungrounded } = detectUngroundedBlockers(REPORT_TAIL, results);
		expect(ungrounded).toHaveLength(0);
	});

	test("never flags non-permission gaps (SQL failures, missing metrics)", () => {
		const results = [result({ dataSourceId: "aws", toolErrors: [] })];
		const { ungrounded } = detectUngroundedBlockers(REPORT_TAIL, results);
		// only the IAM bullet matches; the SQL + CloudWatch bullets must not
		expect(ungrounded.some((u) => u.includes("Elasticsearch SQL"))).toBe(false);
		expect(ungrounded.some((u) => u.includes("CloudWatch metrics"))).toBe(false);
	});

	test("returns empty when there is no Gaps section", () => {
		const { ungrounded } = detectUngroundedBlockers("# Report\n\nAll healthy.\n\nConfidence: 0.9", [
			result({ toolErrors: [] }),
		]);
		expect(ungrounded).toHaveLength(0);
	});

	test("does NOT flag an informational logs: mention with no denial phrase", () => {
		const answer =
			"## Gaps\n\n- logs:DescribeLogGroups was queried successfully and returned 12 groups.\n\nConfidence: 0.8";
		const { ungrounded } = detectUngroundedBlockers(answer, [result({ dataSourceId: "aws", toolErrors: [] })]);
		expect(ungrounded).toHaveLength(0);
	});

	test("flags a single ungrounded bullet using 'not authorized' phrasing", () => {
		const answer =
			"## Gaps\n\n- User is not authorized to perform: logs:StartQuery on the collector log group.\n\nConfidence: 0.7";
		const { ungrounded } = detectUngroundedBlockers(answer, [result({ dataSourceId: "aws", toolErrors: [] })]);
		expect(ungrounded).toHaveLength(1);
	});

	test("flags an 'unauthorized' denial bullet when no auth error observed", () => {
		const answer = "## Gaps\n\n- The request was unauthorized; metrics could not be read.\n\nConfidence: 0.7";
		const { ungrounded } = detectUngroundedBlockers(answer, [result({ dataSourceId: "aws", toolErrors: [] })]);
		expect(ungrounded).toHaveLength(1);
	});

	// SIO-1031: the LLM writes "IAM gap persists" — not "iam permission" / "permission gap" — so the
	// SIO-1013 regex missed it and a fabricated DescribeLogGroups blocker printed uncapped.
	test("flags an 'IAM gap persists' bullet when no auth error observed", () => {
		const answer =
			"## Gaps\n\n- `logs:DescribeLogGroups` IAM gap persists in both estates; log group names were obtained from task definitions.\n\nConfidence: 0.71";
		const { ungrounded } = detectUngroundedBlockers(answer, [result({ dataSourceId: "aws", toolErrors: [] })]);
		expect(ungrounded).toHaveLength(1);
		expect(ungrounded[0]).toContain("IAM gap persists");
	});

	test("does NOT flag an 'IAM gap persists' bullet when a real auth toolError exists", () => {
		const answer =
			"## Gaps\n\n- `logs:DescribeLogGroups` IAM gap persists in both estates; log group names were obtained from task definitions.\n\nConfidence: 0.71";
		const results = [
			result({
				dataSourceId: "aws",
				toolErrors: [
					{ toolName: "aws_logs_describe_log_groups", category: "auth", message: "AccessDenied", retryable: false },
				],
			}),
		];
		const { ungrounded } = detectUngroundedBlockers(answer, results);
		expect(ungrounded).toHaveLength(0);
	});
});

// SIO-1054: the fabricated IAM prescription surfaces not only in "## Gaps" but in the
// "## Recommendations" section, written by the ungrounded proposeInvestigate mitigation
// branch. detectUngroundedBlockers must scan Recommendations too so the same grounding
// (and the same 0.59 cap + honest rewrite) applies there.
describe("detectUngroundedBlockers SIO-1054 Recommendations section", () => {
	test("flags an ungrounded IAM prescription in Recommendations when no auth error observed", () => {
		const answer = [
			"## Recommendations",
			"",
			"### Investigate (safe, read-only)",
			"",
			"- [AWS] Resolve the CloudWatch Logs Insights gap on `/ecs/fargate/shared-services-prd-log-group` — add `logs:DescribeLogGroups` to `DevOpsAgentReadOnlyPolicy` per the IAM runbook, then re-query.",
			"- [GitLab] Inspect the commit history for CouchbaseRepository.java.",
			"",
			"Confidence: 0.81",
		].join("\n");
		const { ungrounded } = detectUngroundedBlockers(answer, [result({ dataSourceId: "aws", toolErrors: [] })]);
		expect(ungrounded).toHaveLength(1);
		expect(ungrounded[0]).toContain("logs:DescribeLogGroups");
	});

	test("does NOT flag the Recommendations IAM bullet when a real auth toolError exists", () => {
		const answer = [
			"## Recommendations",
			"",
			"- [AWS] Add `logs:DescribeLogGroups` to `DevOpsAgentReadOnlyPolicy` — IAM gap persists.",
			"",
			"Confidence: 0.81",
		].join("\n");
		const results = [
			result({
				dataSourceId: "aws",
				toolErrors: [{ toolName: "aws_logs_start_query", category: "auth", message: "AccessDenied", retryable: false }],
			}),
		];
		const { ungrounded } = detectUngroundedBlockers(answer, results);
		expect(ungrounded).toHaveLength(0);
	});

	test("does NOT flag a benign non-denial Recommendations bullet", () => {
		const answer =
			"## Recommendations\n\n- [AWS] Diff the connectors-service task definitions to confirm the env var change.\n\nConfidence: 0.81";
		const { ungrounded } = detectUngroundedBlockers(answer, [result({ dataSourceId: "aws", toolErrors: [] })]);
		expect(ungrounded).toHaveLength(0);
	});

	// SIO-1054: the IAM-prescription detector must not swallow benign recommendations that
	// happen to say "add" / "policy" / "permission" in a non-IAM sense.
	test("does NOT flag benign 'add' / 'policy' recommendations", () => {
		const answer = [
			"## Recommendations",
			"",
			"- Add a warning CloudWatch alarm at 35% CPU to catch anomalous spikes.",
			"- [Couchbase] Consider adding an index on the PRICE_ key pattern to speed lookups.",
			"- Enforce a code review policy: MR !70 had zero reviewers.",
			"- Create a Jira ticket to track the CouchbaseRepository log-level fix.",
			"",
			"Confidence: 0.81",
		].join("\n");
		const { ungrounded } = detectUngroundedBlockers(answer, [result({ dataSourceId: "aws", toolErrors: [] })]);
		expect(ungrounded).toHaveLength(0);
	});

	// SIO-1054: the exact production hallucination string must be caught.
	test("flags the exact production 'add logs:DescribeLogGroups to DevOpsAgentReadOnlyPolicy' bullet", () => {
		const answer = [
			"## Recommendations",
			"",
			"### Investigate (safe, read-only)",
			"",
			"- [AWS] Resolve the CloudWatch Logs Insights gap on `/ecs/fargate/shared-services-prd-log-group` — add `logs:DescribeLogGroups` to `DevOpsAgentReadOnlyPolicy` per the IAM runbook, then re-query to directly confirm the WARN pattern from the ECS log stream.",
			"",
			"Confidence: 0.81",
		].join("\n");
		const { ungrounded } = detectUngroundedBlockers(answer, [result({ dataSourceId: "aws", toolErrors: [] })]);
		expect(ungrounded).toHaveLength(1);
		// And it is suppressed when a real auth error was observed.
		const grounded = detectUngroundedBlockers(answer, [
			result({
				dataSourceId: "aws",
				toolErrors: [{ toolName: "aws_logs_start_query", category: "auth", message: "AccessDenied", retryable: false }],
			}),
		]);
		expect(grounded.ungrounded).toHaveLength(0);
	});

	test("flags ungrounded IAM bullets in BOTH Gaps and Recommendations", () => {
		const answer = [
			"## Gaps",
			"",
			"- `logs:DescribeLogGroups` IAM gap persists; access is unconfirmed.",
			"",
			"## Recommendations",
			"",
			"- [AWS] Add `logs:DescribeLogGroups` to `DevOpsAgentReadOnlyPolicy` per the IAM runbook.",
			"",
			"Confidence: 0.81",
		].join("\n");
		const { ungrounded } = detectUngroundedBlockers(answer, [result({ dataSourceId: "aws", toolErrors: [] })]);
		expect(ungrounded).toHaveLength(2);
	});
});

describe("rewriteUngroundedBlockers", () => {
	test("replaces a flagged bullet with an honest 'not retrieved' statement", () => {
		const flagged =
			"- ECS collector application logs (`/ecs/fargate/open-telemetry-prd-log-group`) are inaccessible: `logs:DescribeLogGroups` and `logs:StartQuery` are not permitted for `DevOpsAgentReadOnly`.";
		const answer = `## Gaps\n\n${flagged}\n\nConfidence: 0.62`;
		const out = rewriteUngroundedBlockers(answer, [flagged]);
		expect(out).not.toContain("not permitted for");
		expect(out).toContain("were not retrieved during this investigation");
		expect(out).toContain("Confidence: 0.62"); // other lines untouched
	});

	test("returns answer unchanged when nothing is flagged", () => {
		const answer = "## Gaps\n\n- a real gap\n\nConfidence: 0.9";
		expect(rewriteUngroundedBlockers(answer, [])).toBe(answer);
	});
});
