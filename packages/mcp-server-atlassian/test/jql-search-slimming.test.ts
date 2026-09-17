// test/jql-search-slimming.test.ts
import { describe, expect, test } from "bun:test";
import { DESCRIPTION_TRUNCATE_BYTES } from "../src/tools/custom/get-jira-issue.js";
import { slimJqlSearchText } from "../src/tools/proxy/index.js";

// SIO-1774. Shape from the LangSmith trace of run f77ce7dd: top-level { issues, isLast },
// each issue { expand, id, self, key, fields }, fields.description a markdown STRING. Four of
// the eight hits were 16-22 KB incident reports, which made a maxResults:10 search 127 KB.
const issue = (key: string, description: unknown) => ({
	expand: "",
	id: key,
	self: `https://example.atlassian.net/rest/api/3/issue/${key}`,
	key,
	fields: { summary: `summary of ${key}`, status: { name: "Backlog" }, description },
});
const LONG = `# Incident Report\n\n${"Root cause analysis paragraph. ".repeat(700)}`;

describe("slimJqlSearchText", () => {
	test("caps long descriptions at the single-issue budget and says which issues were cut", () => {
		const text = JSON.stringify({ issues: [issue("DEVOPS-1399", LONG), issue("DEVOPS-745", "short")], isLast: true });
		const out = JSON.parse(slimJqlSearchText("searchJiraIssuesUsingJql", text));
		const [long, short] = out.issues;
		expect(Buffer.byteLength(long.fields.description, "utf8")).toBeLessThanOrEqual(DESCRIPTION_TRUNCATE_BYTES);
		expect(long.fields.description.startsWith("# Incident Report")).toBe(true);
		expect(long.fields.description).toContain("truncated");
		expect(short.fields.description).toBe("short");
		// Everything else about the issue survives.
		expect(long.fields.summary).toBe("summary of DEVOPS-1399");
		expect(out.isLast).toBe(true);
		expect(out._projection.truncatedIssues).toEqual(["DEVOPS-1399"]);
		expect(out._projection.hint).toContain("atlassian_getJiraIssue");
		expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThan(Buffer.byteLength(text, "utf8") / 3);
	});

	test("drops browser-only metadata at any depth and keeps the names a reader needs", () => {
		const withUi = issue("DEVOPS-1", "short") as ReturnType<typeof issue> & { fields: Record<string, unknown> };
		withUi.fields.reporter = {
			displayName: "Ada Lovelace",
			self: "https://example.atlassian.net/rest/api/3/user?accountId=1",
			avatarUrls: { "48x48": "https://avatar/48", "24x24": "https://avatar/24" },
		};
		withUi.fields.status = {
			name: "Backlog",
			iconUrl: "https://icon",
			statusCategory: { name: "To Do", self: "https://x" },
		};
		const out = JSON.parse(slimJqlSearchText("searchJiraIssuesUsingJql", JSON.stringify({ issues: [withUi] })));
		const text = JSON.stringify(out.issues);
		for (const gone of ["avatarUrls", "iconUrl", '"self"', '"expand"']) expect(text).not.toContain(gone);
		expect(out.issues[0].key).toBe("DEVOPS-1");
		expect(out.issues[0].fields.reporter).toEqual({ displayName: "Ada Lovelace" });
		expect(out.issues[0].fields.status).toEqual({ name: "Backlog", statusCategory: { name: "To Do" } });
	});

	test("a result with nothing to cut is returned byte-identical, with no sentinel", () => {
		const text = JSON.stringify({
			issues: [{ key: "DEVOPS-745", fields: { summary: "s", description: "short" } }],
			isLast: true,
		});
		expect(slimJqlSearchText("searchJiraIssuesUsingJql", text)).toBe(text);
	});

	test("other tools, non-JSON text, and unexpected shapes pass through untouched", () => {
		const big = JSON.stringify({ issues: [issue("X-1", LONG)] });
		expect(slimJqlSearchText("getJiraIssue", big)).toBe(big);
		expect(slimJqlSearchText("searchJiraIssuesUsingJql", "upstream said no")).toBe("upstream said no");
		expect(slimJqlSearchText("searchJiraIssuesUsingJql", '{"total":3}')).toBe('{"total":3}');
		// A description that is not a string (e.g. a document object) is left for the agent-side cap.
		const adf = JSON.parse(
			slimJqlSearchText(
				"searchJiraIssuesUsingJql",
				JSON.stringify({ issues: [issue("X-2", { type: "doc", content: [] })] }),
			),
		);
		expect(adf.issues[0].fields.description).toEqual({ type: "doc", content: [] });
		expect(adf._projection.truncatedIssues).toEqual([]);
	});
});
