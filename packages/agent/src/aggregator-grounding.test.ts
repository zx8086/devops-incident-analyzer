// packages/agent/src/aggregator-grounding.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import {
	appendSuffixToLine,
	buildPrematureAbsenceCaveats,
	detectPrematureAbsence,
	detectUngroundedBlockers,
	rewriteNoIndexMisread,
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

// SIO-1242: the absence guard no longer mutates the claim -- it records a caveat. These tests were
// previously asserting that a "[CORRECTION: ...]" debug string was appended INSIDE the flagged
// line's last table cell (SIO-1158). That behaviour is what put an internal note in the Correlated
// Timeline's Severity column on run 43796e9f, so the assertions are inverted here: the line must
// come back byte-identical and the correction must arrive as data instead.
describe("buildPrematureAbsenceCaveats (SIO-1242)", () => {
	test("records a caveat per claim and leaves every source line untouched", () => {
		const contra = "prana-order-service does not ship logs; 0 hits.";
		const over = "the afs field is entirely absent from all records.";
		const answer = `### Elasticsearch\n\n${contra}\n\n### Couchbase\n\n${over}\n\nConfidence: 0.8`;
		const caveats = buildPrematureAbsenceCaveats(answer, [{ line: contra, dataSourceId: "elastic" }], [over]);

		expect(caveats.map((c) => c.guard)).toEqual([
			"premature-absence-contradicted",
			"premature-absence-overgeneralized",
		]);
		expect(caveats[0]?.claim).toBe(contra);
		expect(caveats[0]?.dataSourceId).toBe("elastic");
		expect(caveats[0]?.section).toBe("Elasticsearch");
		expect(caveats[1]?.section).toBe("Couchbase");
		// The answer itself is an input here and is never returned mutated -- nothing to assert on
		// it beyond the fact that no rewriter touched it, which the integration test pins end-to-end.
	});

	test("returns no caveats when nothing is flagged", () => {
		expect(buildPrematureAbsenceCaveats("### Elasticsearch\n\nall good.\n\nConfidence: 0.9", [], [])).toEqual([]);
	});

	// The inversion of the old "keeps a corrected table row a structurally valid table row".
	test("never mutates a flagged table row -- the correction becomes a caveat", () => {
		const answer = `| Pattern | Evidence |\n|---|---|\n${PRODUCTION_TABLE_ROW}\n\nConfidence: 0.8`;
		const caveats = buildPrematureAbsenceCaveats(answer, [{ line: PRODUCTION_TABLE_ROW, dataSourceId: "elastic" }], []);
		expect(caveats).toHaveLength(1);
		expect(caveats[0]?.claim).toBe(PRODUCTION_TABLE_ROW);
		expect(caveats[0]?.note).not.toContain("synthesis error");
		// The row is untouched by construction: nothing in this path writes to `answer`.
		expect(answer.split("\n")[2]).toBe(PRODUCTION_TABLE_ROW);
	});

	// The SIO-1242 acceptance criterion: "every occurrence reconciled, not just the flagged line".
	// Satisfied by construction (nothing is mutated), and made auditable by `occurrences`.
	test("counts every occurrence of a claim that appears more than once", () => {
		const claim = "prana-order-service is not present in this estate.";
		const answer = `### Findings\n\n${claim}\n\n### Timeline\n\n${claim}\n\nConfidence: 0.7`;
		const caveats = buildPrematureAbsenceCaveats(answer, [{ line: claim, dataSourceId: "aws" }], []);
		expect(caveats).toHaveLength(1);
		expect(caveats[0]?.occurrences).toBe(2);
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

// SIO-1242: the run-43796e9f false positive. The aggregator prompt's own crossEstateAbsenceRule
// (SIO-1149) INSTRUCTS the model to write "not deployed in this estate -- a definitive negative
// result", then the absence guard flagged that sanctioned sentence as a fabrication and hard-capped
// the report to 0.59, below the HITL gate. Two guards from different tickets fighting each other.
describe("detectPrematureAbsence: enumeration-backed confirmed negative (SIO-1242)", () => {
	// eu-shared-services-prd returned FIVE non-empty aws_ecs_list_services payloads; none names the
	// focus service. Data was returned, but none of it contradicts the claim -- it proves it.
	const ecsEnumeration = [
		{ toolName: "aws_ecs_list_services", rawJson: { serviceArns: ["arn:...:service/authentication-service"] } },
		{ toolName: "aws_ecs_list_services", rawJson: { serviceArns: ["arn:...:service/bitly-service"] } },
		{ toolName: "aws_ecs_list_services", rawJson: { serviceArns: ["arn:...:service/brads-service"] } },
		{ toolName: "aws_logs_describe_log_groups", rawJson: { logGroups: [] } },
	];
	const ABSENCE_LINE = "`prana-order-service` is not present across all 5 ECS clusters (aws_ecs_list_services).";

	test("does NOT flag a claim whose entity is absent from a non-empty enumeration", () => {
		const { contradicted } = detectPrematureAbsence(`${ABSENCE_LINE}\n\nConfidence: 0.72`, [
			result({ dataSourceId: "aws", deploymentId: "estate:eu-shared-services-prd", toolOutputs: ecsEnumeration }),
		]);
		expect(contradicted).toEqual([]);
	});

	// The SIO-1085 guard must survive: when the evidence DOES name the entity, that is a real
	// contradiction and stays flagged.
	test("still flags when the returned data mentions the claimed-absent entity", () => {
		const mentions = [
			{ toolName: "aws_ecs_list_services", rawJson: { serviceArns: ["arn:...:service/prana-order-service"] } },
		];
		const { contradicted } = detectPrematureAbsence(`${ABSENCE_LINE}\n\nConfidence: 0.72`, [
			result({ dataSourceId: "aws", toolOutputs: mentions }),
		]);
		expect(contradicted).toHaveLength(1);
	});

	// THE LOAD-BEARING GATE. "Total results: 91" is a COUNT, not an enumeration -- it could never
	// have listed the entity, so it must not be allowed to exempt anything. Without this the
	// SIO-1085 fixture below flips to suppressed and the original guard is silently gutted.
	test("a bare count is not an enumeration and cannot suppress (SIO-1085 stays flagged)", () => {
		const answer =
			"### Elasticsearch\n\n`prana-order-service` does not ship logs to the connected Elasticsearch cluster; 0 hits.\n\nConfidence: 0.8";
		const { contradicted } = detectPrematureAbsence(answer, [
			result({
				dataSourceId: "elastic",
				toolOutputs: [{ toolName: "elasticsearch_search", rawJson: "Total results: 91, showing 5 from position 0" }],
			}),
		]);
		expect(contradicted).toHaveLength(1);
	});

	test("a claim with no extractable entity keeps the pre-SIO-1242 behaviour", () => {
		const answer = "### Elasticsearch\n\nno matching documents in the elastic index.\n\nConfidence: 0.8";
		const { contradicted } = detectPrematureAbsence(answer, [
			result({
				dataSourceId: "elastic",
				toolOutputs: [{ toolName: "elasticsearch_search", rawJson: [{ _source: { message: "boom" } }] }],
			}),
		]);
		expect(contradicted).toHaveLength(1);
	});

	test("the kill switch restores the pre-SIO-1242 flag", () => {
		const prev = process.env.ABSENCE_ENTITY_MATCH_ENABLED;
		process.env.ABSENCE_ENTITY_MATCH_ENABLED = "false";
		try {
			const { contradicted } = detectPrematureAbsence(`${ABSENCE_LINE}\n\nConfidence: 0.72`, [
				result({ dataSourceId: "aws", toolOutputs: ecsEnumeration }),
			]);
			expect(contradicted).toHaveLength(1);
		} finally {
			if (prev === undefined) delete process.env.ABSENCE_ENTITY_MATCH_ENABLED;
			else process.env.ABSENCE_ENTITY_MATCH_ENABLED = prev;
		}
	});

	// Attribution: pre-SIO-1242 DATASOURCE_KEYWORDS had no `aws` entry, so an AWS claim could only
	// be caught by an incidental keyword and was judged against the WRONG datasource's evidence.
	test("attributes an AWS claim to aws, not to an incidental keyword", () => {
		// NB the line must match ABSENCE_CLAIM_RE ("not present"), and mentions BOTH an aws keyword
		// (CloudWatch) and incidental elastic/kafka ones (APM, topic) -- only aws has data, so aws is
		// the only attributable owner. Pre-SIO-1242 there was no `aws` key to attribute to at all.
		const { contradictedDetails } = detectPrematureAbsence(
			"`checkout-api` is not present in any CloudWatch log group; the APM topic was not queried.\n\nConfidence: 0.7",
			[result({ dataSourceId: "aws", toolOutputs: [{ toolName: "aws_x", rawJson: { total: 3 } }] })],
		);
		expect(contradictedDetails[0]?.dataSourceId).toBe("aws");
	});
});
