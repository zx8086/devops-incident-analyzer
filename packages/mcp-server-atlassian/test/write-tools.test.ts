import { describe, expect, test } from "bun:test";
import { isWriteTool } from "../src/tools/proxy/write-tools.js";

describe("isWriteTool", () => {
	test.each([
		"createJiraIssue",
		"updateJiraIssue",
		"deleteJiraIssue",
		"addCommentToJiraIssue",
		"addAttachmentToJiraIssue",
		"transitionJiraIssue",
		"assignJiraIssue",
		"moveConfluencePage",
		"createConfluencePage",
		"updateConfluencePage",
		// SIO-1183 (SIO-1181 audit F4): these two leaked through the read-only filter --
		// no /^edit/ pattern, and the add-pattern did not cover Worklog.
		"editJiraIssue",
		"addWorklogToJiraIssue",
		// The remaining live write tools (2026-07-23 tools/list), pinned so a future
		// upstream rename that dodges the patterns fails this suite, not production.
		"createConfluenceFooterComment",
		"createConfluenceInlineComment",
		"createIssueLink",
	])("classifies %s as write", (name) => {
		expect(isWriteTool(name)).toBe(true);
	});

	// SIO-1183: the full live read-tool surface (2026-07-23 tools/list, unprefixed upstream
	// names) -- none of these may ever classify as write, or read-only mode would drop them.
	test.each([
		"searchJiraIssuesUsingJql",
		"getJiraIssue",
		"getJiraIssueComments",
		"searchConfluencePages",
		"getConfluencePage",
		"getAccessibleAtlassianResources",
		"lookupJiraIssue",
		"atlassianUserInfo",
		"searchConfluenceUsingCql",
		"getConfluenceSpaces",
		"getPagesInConfluenceSpace",
		"getConfluencePageFooterComments",
		"getConfluencePageInlineComments",
		"getConfluenceCommentChildren",
		"getConfluencePageDescendants",
		"getTransitionsForJiraIssue",
		"getJiraIssueRemoteIssueLinks",
		"getVisibleJiraProjects",
		"getJiraProjectIssueTypesMetadata",
		"getJiraIssueTypeMetaWithFields",
		"lookupJiraAccountId",
		"getIssueLinkTypes",
		"search",
		"fetch",
	])("classifies %s as read", (name) => {
		expect(isWriteTool(name)).toBe(false);
	});
});
