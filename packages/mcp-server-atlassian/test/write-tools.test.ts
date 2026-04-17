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
	])("classifies %s as write", (name) => {
		expect(isWriteTool(name)).toBe(true);
	});

	test.each([
		"searchJiraIssuesUsingJql",
		"getJiraIssue",
		"getJiraIssueComments",
		"searchConfluencePages",
		"getConfluencePage",
		"getAccessibleAtlassianResources",
		"lookupJiraIssue",
	])("classifies %s as read", (name) => {
		expect(isWriteTool(name)).toBe(false);
	});
});
