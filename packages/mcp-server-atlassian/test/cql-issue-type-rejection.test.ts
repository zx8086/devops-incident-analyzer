// test/cql-issue-type-rejection.test.ts
import { describe, expect, test } from "bun:test";
import { cqlIssueTypeRejection } from "../src/tools/proxy/index.js";

// SIO-1159: CQL `type` accepts only Confluence content types. LLM callers point it
// at Jira with `type = issue` and get an opaque upstream 400 (run 270378e0). The
// proxy rejects it up front with a bad-input envelope steering to the JQL tool.
describe("cqlIssueTypeRejection", () => {
	test("rejects type = issue with a bad-input envelope naming the JQL tool", () => {
		const rejection = cqlIssueTypeRejection("searchConfluenceUsingCql", {
			cql: 'type = issue AND text ~ "sync failure"',
		});
		expect(rejection?._error.kind).toBe("bad-input");
		expect(rejection?._error.advice).toContain("atlassian_searchJiraIssuesUsingJql");
		expect(rejection?._error.advice).toContain("blogpost");
	});

	test("rejects compact and IN-clause variants case-insensitively", () => {
		for (const cql of ["type=issue", "TYPE = Issue", 'type IN (issue, page) AND space = "OPS"', "type = issues"]) {
			expect(cqlIssueTypeRejection("searchConfluenceUsingCql", { cql })).not.toBeNull();
		}
	});

	test("valid content types pass through", () => {
		for (const cql of [
			'type = page AND title ~ "runbook"',
			"type = blogpost",
			'type IN (page, attachment) AND space = "OPS"',
			// "issue" as free text, not a type value
			'text ~ "issue with sync" AND type = page',
		]) {
			expect(cqlIssueTypeRejection("searchConfluenceUsingCql", { cql })).toBeNull();
		}
	});

	test("other tools and non-string cql are ignored", () => {
		expect(cqlIssueTypeRejection("search", { cql: "type = issue" })).toBeNull();
		expect(cqlIssueTypeRejection("searchConfluenceUsingCql", { cql: 42 })).toBeNull();
		expect(cqlIssueTypeRejection("searchConfluenceUsingCql", {})).toBeNull();
	});
});
