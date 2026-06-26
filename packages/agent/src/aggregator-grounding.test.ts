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
