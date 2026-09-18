// packages/agent/src/aggregator-results-block.test.ts
// SIO-1441: buildResultsBlock is extracted from aggregate()'s previously-inline resultsBlock
// construction so the tier-2 orchestrator probe can build an identical prompt without
// duplicating this formatting logic (header shape, tool-error surfacing, per-result
// truncation). Pure refactor -- these tests pin the existing behavior before/after extraction.
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { buildResultsBlock } from "./aggregator.ts";

function result(over: Partial<DataSourceResult>): DataSourceResult {
	return { dataSourceId: "gitlab", data: "some findings", status: "success", ...over };
}

describe("buildResultsBlock", () => {
	test("formats a single successful result with a header and the data", () => {
		const block = buildResultsBlock([result({ duration: 1234 })]);
		expect(block).toBe("### gitlab [OK] (1234ms)\nsome findings");
	});

	test("formats an error result with the error message, not the data", () => {
		const block = buildResultsBlock([result({ status: "error", error: "MCP connection refused", data: "unused" })]);
		expect(block).toContain("### gitlab [ERROR: MCP connection refused]");
		expect(block).not.toContain("unused");
	});

	test("labels a deployment-scoped result as dataSourceId/deploymentId", () => {
		const block = buildResultsBlock([result({ dataSourceId: "elastic", deploymentId: "eu-cld" })]);
		expect(block).toContain("### elastic/eu-cld [OK]");
	});

	test("appends a tool-errors block listing each failure when toolErrors is non-empty", () => {
		const block = buildResultsBlock([
			result({
				toolErrors: [{ toolName: "gitlab_search", category: "auth", message: "401 Unauthorized", retryable: false }],
			}),
		]);
		expect(block).toContain("Tool errors (1 failures)");
		expect(block).toContain("gitlab_search [auth]: 401 Unauthorized");
	});

	// SIO-1815: the model only ever saw the failure, so it reported a recovered call as a gap.
	test("labels only a PROVEN recovery; a lenient one and a plain failure stay bare", () => {
		const block = buildResultsBlock([
			result({
				toolErrors: [
					{
						toolName: "gitlab_get_merge_request",
						category: "unknown",
						message: "include",
						retryable: false,
						recovered: true,
						recoveredSameTarget: true,
					},
					// Lenient only ("nothing conflicted"): not proof, so it reads as a plain failure.
					{
						toolName: "capella_run_sql_plus_plus_query",
						category: "bad-query",
						message: "syntax",
						retryable: false,
						recovered: true,
					},
					{ toolName: "gitlab_search", category: "auth", message: "401 Unauthorized", retryable: false },
				],
			}),
		]);
		expect(block).toContain(
			"gitlab_get_merge_request [unknown]: include [a later call to this tool for the SAME target SUCCEEDED",
		);
		expect(block).toContain("capella_run_sql_plus_plus_query [bad-query]: syntax\n");
		expect(block).toContain("gitlab_search [auth]: 401 Unauthorized\n");
	});

	test("omits the tool-errors block entirely when there are no tool errors", () => {
		const block = buildResultsBlock([result({})]);
		expect(block).not.toContain("Tool errors");
	});

	test("joins multiple results with a blank line between them", () => {
		const block = buildResultsBlock([result({ dataSourceId: "gitlab" }), result({ dataSourceId: "elastic" })]);
		expect(block).toContain("### gitlab");
		expect(block).toContain("### elastic");
		expect(block.split("\n\n").length).toBeGreaterThanOrEqual(2);
	});
});
