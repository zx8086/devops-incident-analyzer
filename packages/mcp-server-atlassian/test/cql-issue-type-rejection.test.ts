// test/cql-issue-type-rejection.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AtlassianMcpProxy, ProxyToolInfo } from "../src/atlassian-client/index.js";
import { cqlIssueTypeRejection, registerProxyTools } from "../src/tools/proxy/index.js";

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

	test("rejects compact, quoted, and IN-clause variants case-insensitively", () => {
		for (const cql of [
			"type=issue",
			"TYPE = Issue",
			'type = "issue"',
			"type = 'issue'",
			'type IN (issue, page) AND space = "OPS"',
			// issue NOT first in the IN list (regression: substring regex missed it)
			"type IN (page, issue)",
			'type IN ("page", "issue")',
			"type = issues",
		]) {
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
			// the whole predicate inside quoted search text is NOT a type clause
			// (regression: substring regex false-fired on this)
			'text ~ "type = issue"',
			'text ~ "type IN (page, issue)" AND type = page',
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

// SIO-1159 follow-up (CodeRabbit): exercise the rejection through the REGISTERED
// proxy tool handler, not only the exported helper -- proving the guard sits in
// front of the upstream round trip.
describe("registered atlassian_searchConfluenceUsingCql handler (e2e)", () => {
	type ToolHandler = (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;

	function registerAndGetHandler(callTool: ReturnType<typeof mock>) {
		const handlers = new Map<string, ToolHandler>();
		const server = {
			tool: (name: string, _desc: string, _shape: unknown, handler: ToolHandler) => {
				handlers.set(name, handler);
			},
		} as unknown as McpServer;
		const proxy = { callTool } as unknown as AtlassianMcpProxy;
		const remoteTools: ProxyToolInfo[] = [
			{
				name: "searchConfluenceUsingCql",
				description: "Search Confluence using CQL",
				inputSchema: { type: "object", properties: { cql: { type: "string" } }, required: ["cql"] },
			},
		];
		registerProxyTools(server, proxy, remoteTools, { readOnly: true });
		const handler = handlers.get("atlassian_searchConfluenceUsingCql");
		if (!handler) throw new Error("tool was not registered");
		return handler;
	}

	test("type = issue returns the bad-input envelope WITHOUT calling upstream", async () => {
		const callTool = mock(async () => ({ content: [{ type: "text", text: "should not be reached" }] }));
		const handler = registerAndGetHandler(callTool);

		const result = await handler({ cql: 'type = issue AND text ~ "sync failure"' });

		expect(callTool).not.toHaveBeenCalled();
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
			_error?: { kind?: string; advice?: string };
		};
		expect(parsed._error?.kind).toBe("bad-input");
		expect(parsed._error?.advice).toContain("atlassian_searchJiraIssuesUsingJql");
	});

	test("a valid CQL type passes through to the upstream proxy", async () => {
		const callTool = mock(async () => ({ content: [{ type: "text", text: "upstream ok" }] }));
		const handler = registerAndGetHandler(callTool);

		const result = await handler({ cql: 'type = page AND title ~ "runbook"' });

		expect(callTool).toHaveBeenCalledTimes(1);
		expect(result.content[0]?.text).toBe("upstream ok");
	});
});
