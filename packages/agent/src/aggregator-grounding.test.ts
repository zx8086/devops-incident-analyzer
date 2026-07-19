// packages/agent/src/aggregator-grounding.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import {
	appendSuffixToLine,
	detectPrematureAbsence,
	detectUngroundedBlockers,
	rewriteNoIndexMisread,
	rewritePrematureAbsence,
	rewriteUngroundedBlockers,
	rewriteUngroundedRootCause,
} from "./aggregator.ts";

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

	// SIO-1120: grounding is per-action. The REPORT_TAIL bullet names logs:DescribeLogGroups AND
	// logs:StartQuery, so BOTH must be observed-denied for it to be grounded. A realistic AWS
	// iam-permission-missing message carries the action token, which the detector extracts.
	test("does NOT flag when auth errors name BOTH actions the bullet claims", () => {
		const results = [
			result({
				dataSourceId: "aws",
				toolErrors: [
					{
						toolName: "aws_logs_describe_log_groups",
						category: "auth",
						message: 'Update DevOpsAgentReadOnlyPolicy to include "logs:DescribeLogGroups".',
						retryable: false,
					},
					{
						toolName: "aws_logs_start_query",
						category: "auth",
						message: 'Update DevOpsAgentReadOnlyPolicy to include "logs:StartQuery".',
						retryable: false,
					},
				],
			}),
		];
		const { ungrounded } = detectUngroundedBlockers(REPORT_TAIL, results);
		expect(ungrounded).toHaveLength(0);
	});

	// SIO-1120: THE core regression. An auth error for one action (logs:StartQuery) must NOT
	// ground a bullet that ALSO names a different action (logs:DescribeLogGroups) that was never
	// denied. Before the per-action fix, any single auth error suppressed the whole report.
	test("STILL flags when the bullet names an action that was NOT among the observed denials", () => {
		const results = [
			result({
				dataSourceId: "aws",
				toolErrors: [
					{
						toolName: "aws_logs_start_query",
						category: "auth",
						message: 'Update DevOpsAgentReadOnlyPolicy to include "logs:StartQuery".',
						retryable: false,
					},
				],
			}),
		];
		const { ungrounded } = detectUngroundedBlockers(REPORT_TAIL, results);
		// logs:DescribeLogGroups was never denied -> the bullet is still fabricated.
		expect(ungrounded).toHaveLength(1);
		expect(ungrounded[0]).toContain("logs:DescribeLogGroups");
	});

	// SIO-1120: the exact localcore bug. A REAL auth error for an unrelated action does not ground
	// a fabricated "ec2:DescribeRouteTables not permitted" bullet -- DescribeRouteTables is granted
	// by the base policy and was never observed as denied.
	test("flags a granted-action 'not permitted' bullet even when an unrelated auth error exists", () => {
		const answer = [
			"## Gaps",
			"",
			"- Route table configuration could not be confirmed: `ec2:DescribeRouteTables` and `ec2:DescribeVpcEndpoints` are currently not permitted for `DevOpsAgentReadOnly`.",
			"",
			"Confidence: 0.81",
		].join("\n");
		const results = [
			result({
				dataSourceId: "aws",
				toolErrors: [
					{
						toolName: "aws_logs_start_query",
						category: "auth",
						message: 'Update DevOpsAgentReadOnlyPolicy to include "logs:StartQuery".',
						retryable: false,
					},
				],
			}),
		];
		const { ungrounded } = detectUngroundedBlockers(answer, results);
		expect(ungrounded).toHaveLength(1);
		expect(ungrounded[0]).toContain("ec2:DescribeRouteTables");
	});

	// SIO-1120: a granted action CAN be legitimately reported denied when the deployed role in an
	// estate actually rejected it (observation wins over the committed grant list).
	test("does NOT flag a granted action when it WAS actually observed as denied", () => {
		const answer = [
			"## Gaps",
			"",
			"- `ec2:DescribeVpcEndpoints` is not permitted for `DevOpsAgentReadOnly` in this estate; VPC endpoint status is unconfirmed.",
			"",
			"Confidence: 0.7",
		].join("\n");
		const results = [
			result({
				dataSourceId: "aws",
				toolErrors: [
					{
						toolName: "aws_ec2_describe_vpc_endpoints",
						category: "auth",
						message: "User is not authorized to perform: ec2:DescribeVpcEndpoints",
						retryable: false,
					},
				],
			}),
		];
		const { ungrounded } = detectUngroundedBlockers(answer, results);
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

	test("does NOT flag an 'IAM gap persists' bullet when a real auth toolError names that action", () => {
		const answer =
			"## Gaps\n\n- `logs:DescribeLogGroups` IAM gap persists in both estates; log group names were obtained from task definitions.\n\nConfidence: 0.71";
		const results = [
			result({
				dataSourceId: "aws",
				toolErrors: [
					{
						toolName: "aws_logs_describe_log_groups",
						category: "auth",
						// SIO-1120: message must name the action for per-action grounding.
						message: 'Update DevOpsAgentReadOnlyPolicy to include "logs:DescribeLogGroups".',
						retryable: false,
					},
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

	test("does NOT flag the Recommendations IAM bullet when a real auth toolError names that action", () => {
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
				toolErrors: [
					{
						toolName: "aws_logs_describe_log_groups",
						category: "auth",
						// SIO-1120: message must name logs:DescribeLogGroups (the action the bullet prescribes).
						message: 'Update DevOpsAgentReadOnlyPolicy to include "logs:DescribeLogGroups".',
						retryable: false,
					},
				],
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
		// And it is suppressed when a real auth error NAMING logs:DescribeLogGroups was observed.
		const grounded = detectUngroundedBlockers(answer, [
			result({
				dataSourceId: "aws",
				toolErrors: [
					{
						toolName: "aws_logs_describe_log_groups",
						category: "auth",
						message: 'Update DevOpsAgentReadOnlyPolicy to include "logs:DescribeLogGroups".',
						retryable: false,
					},
				],
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

// SIO-1158: the shape of the 2026-07 production correlation-table false positive
// (identifiers genericized). It is an AWS CloudWatch finding ("no records for season X")
// that mentions "Elasticsearch APM" only incidentally; the naive suffix append after its
// trailing pipe garbled the table.
const PRODUCTION_TABLE_ROW =
	"| Upstream data gap causes HTTP 500 | delivery-dates-service has no records for season 2031TEST (CloudWatch Logs, estate-b-prd) -> returns HTTP 500 -> catalog-sync-service wraps as StockSyncException (Elasticsearch APM, CloudWatch Logs estate-a-prd) |";

// SIO-1085: guard against premature-conclusion absence claims.
describe("detectPrematureAbsence", () => {
	// A. CONTRADICTED: elastic reports "not present" but its sub-agent returned hits.
	test("flags an elastic 'not present' claim when the elastic sub-agent returned hits", () => {
		const answer =
			"### Elasticsearch\n\nprana-order-service does not ship logs to the connected Elasticsearch cluster; 0 hits for the AFS error.\n\nConfidence: 0.8";
		const results = [
			result({
				dataSourceId: "elastic",
				toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "Total results: 91, showing 5 from position 0" }],
			}),
		];
		const { contradicted } = detectPrematureAbsence(answer, results);
		expect(contradicted).toHaveLength(1);
		expect(contradicted[0]).toContain("does not ship logs");
	});

	// SIO-1158: the flagging datasource travels with the line so the absence judge can
	// weigh the claim against exactly that datasource's returned data.
	test("returns contradictedDetails naming the flagging datasource", () => {
		const answer =
			"### Elasticsearch\n\norder-sync-service does not ship logs to the connected Elasticsearch cluster; 0 hits for the checkout error.\n\nConfidence: 0.8";
		const results = [
			result({
				dataSourceId: "elastic",
				toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "Total results: 91, showing 5 from position 0" }],
			}),
		];
		const { contradicted, contradictedDetails } = detectPrematureAbsence(answer, results);
		expect(contradictedDetails).toHaveLength(1);
		expect(contradictedDetails[0]?.dataSourceId).toBe("elastic");
		expect(contradictedDetails[0]?.line).toBe(contradicted[0] as string);
	});

	// SIO-1158: production false positive #2 -- an AWS CloudWatch-grounded table row
	// regex-flags via its incidental "Elasticsearch APM" mention. The regex arm SHOULD
	// flag it (it cannot know better); the absence judge downstream is what exonerates it.
	test("regex-flags the production correlation-table row via its incidental elastic keyword", () => {
		const answer = `${PRODUCTION_TABLE_ROW}\n\nConfidence: 0.84`;
		const results = [
			result({
				dataSourceId: "elastic",
				toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "Total results: 30, showing 5 from position 0" }],
			}),
		];
		const { contradictedDetails } = detectPrematureAbsence(answer, results);
		expect(contradictedDetails).toEqual([{ line: PRODUCTION_TABLE_ROW, dataSourceId: "elastic" }]);
	});

	test("does NOT flag an elastic absence claim when elastic genuinely returned nothing", () => {
		const answer = "### Elasticsearch\n\nservice not present; 0 hits.\n\nConfidence: 0.8";
		const results = [
			result({
				dataSourceId: "elastic",
				toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "Total results: 0, showing 0 from position 0" }],
			}),
		];
		const { contradicted } = detectPrematureAbsence(answer, results);
		expect(contradicted).toHaveLength(0);
	});

	// B. OVER-GENERALIZED: couchbase generalizes "absent from all records" from one collection.
	test("flags a sweeping 'absent from all records' couchbase claim", () => {
		const answer =
			"### Couchbase\n\nThe new_model.seasonal_assignment collection has the afs field entirely absent from all records; the whole pipeline is empty.\n\nConfidence: 0.82";
		const { overgeneralized } = detectPrematureAbsence(answer, [result({ dataSourceId: "couchbase" })]);
		expect(overgeneralized.length).toBeGreaterThanOrEqual(1);
		expect(overgeneralized[0]).toContain("entirely absent from all records");
	});

	test("does NOT flag a scoped, non-sweeping absence statement", () => {
		const answer =
			"### Couchbase\n\nThe queried collection new_model.seasonal_assignment returned 7 docs, 0 with an afs field.\n\nConfidence: 0.7";
		const { contradicted, overgeneralized } = detectPrematureAbsence(answer, [result({ dataSourceId: "couchbase" })]);
		expect(contradicted).toHaveLength(0);
		expect(overgeneralized).toHaveLength(0);
	});

	test("ignores headings and returns empty on a clean report", () => {
		const answer = "# Report\n\n## Findings\n\nAll services healthy.\n\nConfidence: 0.9";
		const { contradicted, overgeneralized } = detectPrematureAbsence(answer, [result({ dataSourceId: "elastic" })]);
		expect(contradicted).toHaveLength(0);
		expect(overgeneralized).toHaveLength(0);
	});
});

describe("rewritePrematureAbsence", () => {
	test("appends a correction to a contradicted absence line and a scope caveat to an over-generalized one", () => {
		const contra = "prana-order-service does not ship logs; 0 hits.";
		const over = "the afs field is entirely absent from all records.";
		const answer = `### Elasticsearch\n\n${contra}\n\n### Couchbase\n\n${over}\n\nConfidence: 0.8`;
		const out = rewritePrematureAbsence(answer, [contra], [over]);
		expect(out).toContain("CORRECTION: this datasource's sub-agent returned matching data");
		expect(out).toContain("SCOPE: this states absence more broadly than was verified");
		expect(out).toContain("Confidence: 0.8"); // untouched lines preserved
	});

	test("returns the answer unchanged when nothing is flagged", () => {
		const answer = "### Elasticsearch\n\nall good.\n\nConfidence: 0.9";
		expect(rewritePrematureAbsence(answer, [], [])).toBe(answer);
	});

	// SIO-1158: production false positive #2's structural half -- a confirmed contradiction
	// inside a table row must land INSIDE the last cell, not after the trailing pipe.
	test("keeps a corrected table row a structurally valid table row", () => {
		const answer = `| Pattern | Evidence |\n|---|---|\n${PRODUCTION_TABLE_ROW}\n\nConfidence: 0.8`;
		const out = rewritePrematureAbsence(answer, [PRODUCTION_TABLE_ROW], []);
		const lines = out.split("\n");
		expect(lines[0]).toBe("| Pattern | Evidence |");
		expect(lines[1]).toBe("|---|---|");
		const row = lines[2] ?? "";
		expect(row).toContain("[CORRECTION");
		expect(row.trimEnd().endsWith("|")).toBe(true);
		expect(row.indexOf("[CORRECTION")).toBeLessThan(row.lastIndexOf("|"));
		expect(row.split("|").length).toBe(PRODUCTION_TABLE_ROW.split("|").length);
	});
});

// SIO-1158: markdown-safe suffix insertion, shared by the three append-based rewriters.
describe("appendSuffixToLine", () => {
	test("appends plainly to a non-table line", () => {
		expect(appendSuffixToLine("plain claim.", " [X]")).toBe("plain claim. [X]");
	});

	test("inserts inside the last cell of a table row, before the trailing pipe", () => {
		const out = appendSuffixToLine(PRODUCTION_TABLE_ROW, " [CORRECTION: test]");
		expect(out).toMatch(/^\s*\|.*\|\s*$/);
		expect(out.split("|").length).toBe(PRODUCTION_TABLE_ROW.split("|").length);
		expect(out.indexOf("[CORRECTION: test]")).toBeLessThan(out.lastIndexOf("|"));
		expect(out.endsWith("estate-a-prd)  [CORRECTION: test] |")).toBe(true);
	});
});

describe("table-safe suffix adoption in sibling rewriters (SIO-1158)", () => {
	test("rewriteUngroundedRootCause keeps a flagged table row structurally valid", () => {
		const row = "| cause | schema mismatch in the article collection |";
		const out = rewriteUngroundedRootCause(`${row}\nConfidence: 0.8`, [row]);
		const rewritten = out.split("\n")[0] ?? "";
		expect(rewritten).toContain("[UNVERIFIED");
		expect(rewritten.trimEnd().endsWith("|")).toBe(true);
		expect(rewritten.indexOf("[UNVERIFIED")).toBeLessThan(rewritten.lastIndexOf("|"));
	});

	test("rewriteNoIndexMisread keeps a flagged table row structurally valid", () => {
		const row = "| couchbase | the article collection has no data |";
		const out = rewriteNoIndexMisread(`${row}\nConfidence: 0.8`, [row]);
		const rewritten = out.split("\n")[0] ?? "";
		expect(rewritten).toContain("[CORRECTION");
		expect(rewritten.trimEnd().endsWith("|")).toBe(true);
		expect(rewritten.indexOf("[CORRECTION")).toBeLessThan(rewritten.lastIndexOf("|"));
	});
});
