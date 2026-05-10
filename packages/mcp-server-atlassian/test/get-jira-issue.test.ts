// test/get-jira-issue.test.ts
// SIO-706: pin the field-projection behavior of the custom getJiraIssue wrapper.

import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import { getJiraIssue, TRIAGE_FIELDS } from "../src/tools/custom/get-jira-issue.js";

interface CapturedCall {
	tool: string;
	args: Record<string, unknown>;
}

function makeFakeProxy(response: unknown, captured: CapturedCall[]): AtlassianMcpProxy {
	return {
		callTool: async (tool: string, args: Record<string, unknown>) => {
			captured.push({ tool, args });
			return {
				content: [{ type: "text", text: JSON.stringify(response) }],
			};
		},
	} as unknown as AtlassianMcpProxy;
}

function bigJiraIssue(): Record<string, unknown> {
	return {
		id: "10001",
		key: "INC-42",
		self: "https://tommy.atlassian.net/rest/api/3/issue/10001",
		fields: {
			summary: "checkout API timeouts spike",
			status: { name: "Open" },
			priority: { name: "High" },
			customfield_severity: { value: "P2" },
			assignee: { displayName: "Daisy" },
			reporter: { displayName: "Simon" },
			created: "2026-04-13T10:00:00Z",
			updated: "2026-04-13T11:00:00Z",
			resolutiondate: null,
			labels: ["api", "timeout"],
			components: [{ name: "checkout-api" }],
			issuetype: { name: "Incident" },
			description: "Lots of detail. ".repeat(500),
			comment: { comments: Array.from({ length: 30 }, (_, i) => ({ id: i, body: "x".repeat(2_000) })) },
			attachment: Array.from({ length: 5 }, (_, i) => ({ id: i, filename: `file-${i}.log`, size: 100_000 })),
			renderedFields: { description: "<p>".repeat(2_000) },
			worklog: { worklogs: Array.from({ length: 10 }, (_, i) => ({ id: i, comment: "y".repeat(500) })) },
		},
	};
}

describe("getJiraIssue SIO-706 field projection", () => {
	test("default: applies the triage preset and adds a _projection sentinel", async () => {
		const captured: CapturedCall[] = [];
		const proxy = makeFakeProxy(bigJiraIssue(), captured);

		const out = (await getJiraIssue(proxy, { issueIdOrKey: "INC-42" })) as Record<string, unknown>;

		const fieldsOut = out.fields as Record<string, unknown>;
		// Triage preset fields should be present
		for (const f of TRIAGE_FIELDS) {
			expect(fieldsOut).toHaveProperty(f);
		}
		// Bloat fields must be dropped
		expect(fieldsOut).not.toHaveProperty("comment");
		expect(fieldsOut).not.toHaveProperty("attachment");
		expect(fieldsOut).not.toHaveProperty("renderedFields");
		expect(fieldsOut).not.toHaveProperty("worklog");

		const projection = out._projection as { applied: string[]; droppedFromFields: string[] };
		expect(projection.applied).toEqual([...TRIAGE_FIELDS]);
		expect(projection.droppedFromFields).toContain("comment");
		expect(projection.droppedFromFields).toContain("renderedFields");

		// Final payload size: with the triage preset, projected output should be well
		// under the 64KB sub-agent cap even for an issue with a long description.
		const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
		expect(bytes).toBeLessThan(8_192);
	});

	test("description field is byte-truncated with a marker so it never blows past the cap alone", async () => {
		const captured: CapturedCall[] = [];
		const huge = bigJiraIssue();
		(huge.fields as Record<string, unknown>).description = "x".repeat(50_000);
		const proxy = makeFakeProxy(huge, captured);

		const out = (await getJiraIssue(proxy, { issueIdOrKey: "INC-42" })) as { fields: { description: string } };
		expect(out.fields.description.length).toBeLessThan(5_000);
		expect(out.fields.description).toContain("[truncated,");
	});

	test("explicit fields list narrows further than the triage preset", async () => {
		const captured: CapturedCall[] = [];
		const proxy = makeFakeProxy(bigJiraIssue(), captured);

		const out = (await getJiraIssue(proxy, {
			issueIdOrKey: "INC-42",
			fields: ["summary", "status"],
		})) as Record<string, unknown>;

		const fieldsOut = out.fields as Record<string, unknown>;
		expect(Object.keys(fieldsOut).sort()).toEqual(["status", "summary"]);
		const projection = out._projection as { applied: string[] };
		expect(projection.applied).toEqual(["summary", "status"]);
	});

	test("comma-separated string fields parameter is normalized", async () => {
		const captured: CapturedCall[] = [];
		const proxy = makeFakeProxy(bigJiraIssue(), captured);

		const out = (await getJiraIssue(proxy, {
			issueIdOrKey: "INC-42",
			fields: "summary, status, priority",
		})) as Record<string, unknown>;

		const projection = out._projection as { applied: string[] };
		expect(projection.applied).toEqual(["summary", "status", "priority"]);
	});

	test('fields="*" returns the full upstream issue and forwards no fields filter', async () => {
		const captured: CapturedCall[] = [];
		const proxy = makeFakeProxy(bigJiraIssue(), captured);

		const out = (await getJiraIssue(proxy, {
			issueIdOrKey: "INC-42",
			fields: "*",
		})) as { fields: Record<string, unknown>; _projection?: unknown };

		// Upstream gave us comment/attachment/renderedFields; they're preserved.
		expect(out.fields).toHaveProperty("comment");
		expect(out.fields).toHaveProperty("attachment");
		expect(out.fields).toHaveProperty("renderedFields");
		// No projection sentinel when fields="*"
		expect(out._projection).toBeUndefined();

		// Upstream call must NOT have a fields argument when "*" is requested.
		expect(captured[0]?.args.fields).toBeUndefined();
	});

	test("forwards the fields list to the upstream call for server-side filtering", async () => {
		const captured: CapturedCall[] = [];
		const proxy = makeFakeProxy(bigJiraIssue(), captured);

		await getJiraIssue(proxy, {
			issueIdOrKey: "INC-42",
			fields: ["summary", "status"],
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.tool).toBe("getJiraIssue");
		// SIO-713: upstream getJiraIssue requires fields as string[] (not CSV string).
		expect(captured[0]?.args.fields).toEqual(["summary", "status"]);
	});

	test("returns a stub with _projection.error when upstream content is unparseable", async () => {
		const proxy = {
			callTool: async () => ({
				content: [{ type: "text", text: "<html>500 error</html>" }],
			}),
		} as unknown as AtlassianMcpProxy;

		const out = (await getJiraIssue(proxy, { issueIdOrKey: "INC-42" })) as Record<string, unknown>;
		expect(out.key).toBe("INC-42");
		const projection = out._projection as { error?: string };
		expect(projection.error).toContain("Upstream returned no parseable content");
	});

	test("propagates AtlassianAuthRequiredError instead of swallowing it", async () => {
		const proxy = {
			callTool: async () => ({
				isError: true,
				content: [{ type: "text", text: "ATLASSIAN_AUTH_REQUIRED: expired" }],
			}),
		} as unknown as AtlassianMcpProxy;

		await expect(getJiraIssue(proxy, { issueIdOrKey: "INC-42" })).rejects.toThrow("ATLASSIAN_AUTH_REQUIRED");
	});
});
