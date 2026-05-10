// test/parse-atlassian-content.test.ts
// SIO-704: pin the failure modes of the shared Atlassian-content parser.

import { describe, expect, test } from "bun:test";
import { AtlassianAuthRequiredError, parseAtlassianTextContent } from "../src/tools/custom/parse-atlassian-content.js";

interface Captured {
	meta: Record<string, unknown>;
	msg: string;
}

function makeLog(): { warn: (m: Record<string, unknown>, s: string) => void; calls: Captured[] } {
	const calls: Captured[] = [];
	return {
		calls,
		warn: (meta, msg) => {
			calls.push({ meta, msg });
		},
	};
}

describe("parseAtlassianTextContent", () => {
	test("happy path: returns the parsed JSON object", () => {
		const log = makeLog();
		const result = {
			content: [
				{
					type: "text",
					text: JSON.stringify({ issues: [{ key: "INC-1" }] }),
				},
			],
		};
		const parsed = parseAtlassianTextContent<{ issues: Array<{ key: string }> }>(result, {
			upstreamTool: "searchJiraIssuesUsingJql",
			context: { jql: "project = INC" },
			log,
		});
		expect(parsed).toEqual({ issues: [{ key: "INC-1" }] });
		expect(log.calls).toHaveLength(0);
	});

	test("tolerates the {issues, isLast, nextPageToken} pagination envelope", () => {
		const log = makeLog();
		const result = {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						issues: [{ key: "INC-1" }],
						isLast: false,
						nextPageToken: "abc123",
					}),
				},
			],
		};
		const parsed = parseAtlassianTextContent<{ issues: Array<{ key: string }>; isLast?: boolean }>(result, {
			upstreamTool: "searchJiraIssuesUsingJql",
			context: { jql: "x" },
			log,
		});
		expect(parsed?.issues).toHaveLength(1);
		expect(parsed?.isLast).toBe(false);
	});

	test("throws AtlassianAuthRequiredError when text starts with the auth-required signal", () => {
		const log = makeLog();
		const result = {
			isError: true,
			content: [
				{
					type: "text",
					text: "ATLASSIAN_AUTH_REQUIRED: Atlassian authorization expired. Please re-authenticate.",
				},
			],
		};
		expect(() =>
			parseAtlassianTextContent(result, {
				upstreamTool: "searchJiraIssuesUsingJql",
				context: { jql: "x" },
				log,
			}),
		).toThrow(AtlassianAuthRequiredError);
	});

	test("returns null and logs samples when no text block parses to an object", () => {
		const log = makeLog();
		const result = {
			content: [
				{ type: "text", text: "Found 5 issues across 2 pages:" },
				{ type: "text", text: "<html>Server Error</html>" },
			],
		};
		const parsed = parseAtlassianTextContent(result, {
			upstreamTool: "searchJiraIssuesUsingJql",
			context: { jql: "x" },
			log,
		});
		expect(parsed).toBeNull();
		expect(log.calls).toHaveLength(1);
		expect(log.calls[0]?.msg).toContain("Failed to parse searchJiraIssuesUsingJql response");
		expect(log.calls[0]?.meta.blockCount).toBe(2);
		expect(Array.isArray(log.calls[0]?.meta.samples)).toBe(true);
	});

	test("walks past a non-JSON preamble block to find the JSON body", () => {
		const log = makeLog();
		const result = {
			content: [
				{ type: "text", text: "Found 5 issues across 2 pages:" },
				{ type: "text", text: JSON.stringify({ issues: [{ key: "INC-2" }] }) },
			],
		};
		const parsed = parseAtlassianTextContent<{ issues: Array<{ key: string }> }>(result, {
			upstreamTool: "searchJiraIssuesUsingJql",
			context: { jql: "x" },
			log,
		});
		expect(parsed?.issues[0]?.key).toBe("INC-2");
		expect(log.calls).toHaveLength(0);
	});

	test("returns null when content is missing or empty", () => {
		const log = makeLog();
		expect(parseAtlassianTextContent({}, { upstreamTool: "x", context: {}, log })).toBeNull();
		expect(parseAtlassianTextContent({ content: [] }, { upstreamTool: "x", context: {}, log })).toBeNull();
		expect(log.calls).toHaveLength(2);
		expect(log.calls[0]?.msg).toContain("no text content blocks");
	});

	test("ignores non-text content blocks", () => {
		const log = makeLog();
		const result = {
			content: [
				{ type: "image", data: "..." },
				{ type: "text", text: JSON.stringify({ issues: [] }) },
			],
		};
		const parsed = parseAtlassianTextContent<{ issues: unknown[] }>(result, {
			upstreamTool: "x",
			context: {},
			log,
		});
		expect(parsed?.issues).toEqual([]);
	});

	test("rejects valid JSON that is not an object (e.g. a bare number/string)", () => {
		const log = makeLog();
		const result = {
			content: [
				{ type: "text", text: JSON.stringify("just a string") },
				{ type: "text", text: JSON.stringify(42) },
			],
		};
		const parsed = parseAtlassianTextContent(result, {
			upstreamTool: "x",
			context: {},
			log,
		});
		expect(parsed).toBeNull();
	});
});
