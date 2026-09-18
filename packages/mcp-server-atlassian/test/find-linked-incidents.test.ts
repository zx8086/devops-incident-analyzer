// test/find-linked-incidents.test.ts
import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import {
	attributeMatch,
	buildJql,
	findLinkedIncidents,
	type JiraIssueRaw,
	shapeIssue,
} from "../src/tools/custom/find-linked-incidents.js";

describe("findLinkedIncidents.buildJql", () => {
	test("constrains to incidentProjects when provided", () => {
		const jql = buildJql({
			service: "checkout-api",
			componentLabel: undefined,
			withinDays: 30,
			incidentProjects: ["INC", "OPS"],
		});
		expect(jql).toContain("project in (INC, OPS)");
		expect(jql).toContain('labels = "checkout-api"');
		expect(jql).toContain("created >= -30d");
	});

	test("falls back when incidentProjects empty", () => {
		const jql = buildJql({ service: "x", componentLabel: undefined, withinDays: 7, incidentProjects: [] });
		expect(jql).toContain("project is not EMPTY");
	});

	test("SIO-1093: broadens beyond an exact label to a text/label OR (service is matched as text too)", () => {
		const jql = buildJql({ service: "order-service", componentLabel: undefined, withinDays: 30, incidentProjects: [] });
		expect(jql).toContain('labels = "order-service"');
		expect(jql).toContain('text ~ "order-service"');
		expect(jql).toContain(" OR ");
	});

	test("SIO-1093: threads errorKeywords as text matches", () => {
		const jql = buildJql({
			service: "order-service",
			componentLabel: undefined,
			errorKeywords: ["AFS season code", "THE1"],
			withinDays: 30,
			incidentProjects: [],
		});
		// SIO-1802: a multi-word keyword is threaded as a PHRASE (inner quotes). Unquoted,
		// JQL treats it as a stemmed bag of words: live, "styles scope" matched a ticket that
		// says "Style" and "out of scope". A single word stays unquoted so stemming helps it.
		expect(jql).toContain('text ~ "\\"AFS season code\\""');
		expect(jql).not.toContain('text ~ "AFS season code"');
		expect(jql).toContain('text ~ "THE1"');
	});

	test("SIO-1802: a quote inside a multi-word keyword stays escaped within the phrase", () => {
		const jql = buildJql({
			service: "svc",
			componentLabel: undefined,
			errorKeywords: ['no "active" seasons'],
			withinDays: 30,
			incidentProjects: [],
		});
		expect(jql).toContain('text ~ "\\"no \\"active\\" seasons\\""');
	});

	test("SIO-1093: blank/whitespace-only errorKeywords are dropped entirely", () => {
		const jql = buildJql({
			service: "svc",
			componentLabel: undefined,
			errorKeywords: ["", "  ", "\t"],
			withinDays: 30,
			incidentProjects: [],
		});
		expect(jql).not.toContain('text ~ ""');
		expect(jql).not.toContain('text ~ "  "');
		expect(jql).not.toContain('text ~ "\t"');
	});

	test("SIO-1093 (CodeRabbit): caps and dedupes errorKeywords", () => {
		// The duplicate kw0 must sit BEFORE the 8-term cap so the dedup path is actually exercised
		// (sanitize breaks once it has 8 terms; a duplicate past that point is never reached).
		const rest = Array.from({ length: 8 }, (_, i) => `kw${i + 1}`); // kw1..kw8
		const jql = buildJql({
			service: "svc",
			componentLabel: undefined,
			errorKeywords: ["kw0", "kw0", ...rest],
			withinDays: 30,
			incidentProjects: [],
		});
		// If dedup were broken, the duplicate kw0 would consume a cap slot and kw7 would be dropped.
		expect(jql).toContain('text ~ "kw7"');
		expect(jql).not.toContain('text ~ "kw8"');
		expect((jql.match(/text ~ "kw0"/g) ?? []).length).toBe(1);
	});
});

describe("findLinkedIncidents.shapeIssue", () => {
	test("extracts severity from priority.name first", () => {
		const shaped = shapeIssue({
			key: "INC-1",
			fields: {
				summary: "db timeout",
				status: { name: "Resolved" },
				priority: { name: "High" },
				customfield_severity: { value: "Critical" },
				created: "2026-04-10T10:00:00Z",
				resolutiondate: "2026-04-10T11:30:00Z",
			},
		});
		expect(shaped.severity).toBe("High");
		expect(shaped.mttrMinutes).toBe(90);
		expect(shaped.key).toBe("INC-1");
	});

	test("falls back to customfield_severity when priority missing", () => {
		const shaped = shapeIssue({
			key: "INC-2",
			fields: {
				summary: "s",
				status: { name: "Open" },
				priority: null,
				customfield_severity: { value: "Sev2" },
				created: "2026-04-10T10:00:00Z",
				resolutiondate: null,
			},
		});
		expect(shaped.severity).toBe("Sev2");
		expect(shaped.mttrMinutes).toBeNull();
		expect(shaped.resolvedAt).toBeNull();
	});

	test("severity null when both missing", () => {
		const shaped = shapeIssue({
			key: "INC-3",
			fields: { summary: "s", status: { name: "Open" }, created: "2026-04-10T10:00:00Z" },
		});
		expect(shaped.severity).toBeNull();
	});

	test("SIO-1802: without match terms the attribution is empty, not guessed", () => {
		const shaped = shapeIssue({
			key: "INC-4",
			fields: { summary: "s", status: { name: "Open" }, created: "2026-04-10T10:00:00Z" },
		});
		expect(shaped.matchedBy).toEqual([]);
		expect(shaped.score).toBe(0);
	});
});

// SIO-1802: each returned ticket says which search clause it visibly satisfies. Shapes
// below mirror the live upstream response (labels: string[], components: [{name}],
// description as markdown text or null).
describe("findLinkedIncidents.attributeMatch (SIO-1802)", () => {
	const issue = (fields: Partial<JiraIssueRaw["fields"]>): JiraIssueRaw => ({
		key: "X-1",
		fields: { summary: "s", status: { name: "Open" }, created: "2026-04-10T10:00:00Z", ...fields },
	});
	const terms = {
		service: "styles-service",
		componentLabel: "Catalog",
		errorKeywords: ["UnambiguousTimeoutException", "kv timeout", "styles scope"],
	};

	test("a label or component hit is structural and scores 3 each", () => {
		expect(attributeMatch(issue({ labels: ["Styles-Service"] }), terms)).toEqual({
			matchedBy: ["service-label"],
			score: 3,
		});
		expect(attributeMatch(issue({ components: [{ name: "catalog" }] }), terms)).toEqual({
			matchedBy: ["component"],
			score: 3,
		});
	});

	test("the service named in summary or description scores 2, each keyword phrase 1", () => {
		const out = attributeMatch(
			issue({
				summary: "Incident Report: styles-service -- Couchbase UnambiguousTimeoutException",
				description: "KV timeout on the article collection",
			}),
			terms,
		);
		expect(out.matchedBy).toEqual(["service-text", "keyword:UnambiguousTimeoutException", "keyword:kv timeout"]);
		expect(out.score).toBe(4);
	});

	test("the live false positive: words of a keyword apart from each other are NOT a hit", () => {
		// The real ticket behind SIO-1802 matched JQL `text ~ "styles scope"` with "Style"
		// in its summary and "out of scope" in its description.
		const out = attributeMatch(
			issue({ summary: "Identify AI-Generated Assets on Style", description: "detection is out of scope" }),
			terms,
		);
		expect(out).toEqual({ matchedBy: [], score: 0 });
	});

	test("a null or non-text description does not throw", () => {
		expect(attributeMatch(issue({ description: null }), terms).score).toBe(0);
		expect(attributeMatch(issue({ description: { type: "doc", content: [] } }), terms).score).toBe(0);
	});
});

describe("findLinkedIncidents ranking (SIO-1802)", () => {
	test("best-attributed first, recency kept as the tie-break, markdown requested", async () => {
		let capturedArgs: Record<string, unknown> | undefined;
		const row = (key: string, summary: string, labels: string[] = []) => ({
			key,
			fields: { summary, status: { name: "Open" }, created: "2026-04-10T10:00:00Z", labels },
		});
		const fakeProxy = {
			callTool: async (_name: string, args: Record<string, unknown>) => {
				capturedArgs = args;
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								// upstream order: created DESC
								issues: [
									row("NEW-1", "unrelated marketing story"),
									row("NEW-2", "another unrelated story"),
									row("OLD-1", "Incident Report: styles-service -- kv timeout"),
									row("OLD-2", "labelled only", ["styles-service"]),
								],
								isLast: true,
							}),
						},
					],
				};
			},
		} as unknown as Parameters<typeof findLinkedIncidents>[0];
		const out = await findLinkedIncidents(fakeProxy, {
			service: "styles-service",
			errorKeywords: ["kv timeout"],
			withinDays: 30,
			limit: 10,
			incidentProjects: [],
		});
		expect(capturedArgs?.responseContentFormat).toBe("markdown");
		expect(out.issues.map((i) => [i.key, i.score])).toEqual([
			["OLD-1", 3],
			["OLD-2", 3],
			["NEW-1", 0],
			["NEW-2", 0],
		]);
		expect(out.issues[0]?.matchedBy).toEqual(["service-text", "keyword:kv timeout"]);
	});
});

// SIO-704: regression tests for the shared parser. findLinkedIncidents already worked in
// production; pin its behavior so future divergence between the three wrappers is caught.
describe("findLinkedIncidents SIO-704 regressions", () => {
	test("tolerates {issues, isLast, nextPageToken} pagination envelope", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{
									key: "INC-1",
									fields: {
										summary: "test",
										status: { name: "Open" },
										created: "2026-04-10T10:00:00Z",
									},
								},
							],
							isLast: false,
							nextPageToken: "next",
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		const result = await findLinkedIncidents(fakeProxy, {
			service: "api",
			withinDays: 30,
			limit: 10,
			incidentProjects: ["INC"],
		});
		expect(result.count).toBe(1);
	});

	// SIO-1336: isLast:false means more incidents matched than the `limit`-bounded page
	// returned. Before this fix, count:N was indistinguishable from "N is the total that
	// matched" -- callers (and the correlation extractor) had no signal that the real count
	// could be higher.
	test("flags truncation via configWarning when isLast is false", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{
									key: "INC-1",
									fields: { summary: "test", status: { name: "Open" }, created: "2026-04-10T10:00:00Z" },
								},
							],
							isLast: false,
							nextPageToken: "next",
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		const result = await findLinkedIncidents(fakeProxy, {
			service: "api",
			withinDays: 30,
			limit: 1,
			incidentProjects: ["INC"],
		});
		expect(result.count).toBe(1);
		expect(result.configWarning).toBeDefined();
		expect(result.configWarning).toContain("truncated");
	});

	test("does not set configWarning when isLast is true", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{
									key: "INC-1",
									fields: { summary: "test", status: { name: "Open" }, created: "2026-04-10T10:00:00Z" },
								},
							],
							isLast: true,
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		const result = await findLinkedIncidents(fakeProxy, {
			service: "api",
			withinDays: 30,
			limit: 10,
			incidentProjects: ["INC"],
		});
		expect(result.configWarning).toBeUndefined();
	});

	test("propagates AtlassianAuthRequiredError instead of silently emptying issues", async () => {
		const fakeProxy = {
			callTool: async () => ({
				isError: true,
				content: [{ type: "text", text: "ATLASSIAN_AUTH_REQUIRED: Atlassian authorization expired." }],
			}),
		} as unknown as AtlassianMcpProxy;
		await expect(
			findLinkedIncidents(fakeProxy, { service: "svc", withinDays: 30, limit: 10, incidentProjects: ["INC"] }),
		).rejects.toThrow("ATLASSIAN_AUTH_REQUIRED");
	});
});

// SIO-1116: the upstream searchJiraIssuesUsingJql now REQUIRES searchResultMode; omitting it
// returned a -32602 whose non-JSON body parsed to null -> a silent count:0. Pin both the
// forwarded arg and the no-longer-silent failure.
describe("findLinkedIncidents SIO-1116 (searchResultMode + loud upstream errors)", () => {
	test("forwards searchResultMode: 'issues' to the upstream", async () => {
		let capturedArgs: Record<string, unknown> | undefined;
		const fakeProxy = {
			callTool: async (_name: string, args: Record<string, unknown>) => {
				capturedArgs = args;
				return { content: [{ type: "text", text: JSON.stringify({ issues: [] }) }] };
			},
		} as unknown as AtlassianMcpProxy;
		await findLinkedIncidents(fakeProxy, { service: "svc", withinDays: 30, limit: 5, incidentProjects: ["INC"] });
		expect(capturedArgs?.searchResultMode).toBe("issues");
		expect(capturedArgs?.maxResults).toBe(5);
	});

	test("throws instead of silently returning count:0 when upstream rejects with a -32602 body", async () => {
		const fakeProxy = {
			callTool: async () => ({
				isError: true,
				content: [
					{
						type: "text",
						text: 'MCP error -32602: Input validation error: [{ "path": ["searchResultMode"], "message": "Invalid input" }]',
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		await expect(
			findLinkedIncidents(fakeProxy, { service: "svc", withinDays: 30, limit: 10, incidentProjects: ["INC"] }),
		).rejects.toThrow(/searchJiraIssuesUsingJql/);
	});
});

describe("findLinkedIncidents (end-to-end with mock proxy)", () => {
	test("returns shaped issues via proxy.callTool", async () => {
		const fakeProxy = {
			callTool: async () => ({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							issues: [
								{
									key: "INC-1",
									fields: {
										summary: "checkout down",
										status: { name: "Resolved" },
										priority: { name: "High" },
										created: "2026-04-10T10:00:00Z",
										resolutiondate: "2026-04-10T10:30:00Z",
									},
								},
							],
						}),
					},
				],
			}),
		} as unknown as AtlassianMcpProxy;
		const result = await findLinkedIncidents(fakeProxy, {
			service: "checkout-api",
			withinDays: 30,
			limit: 10,
			incidentProjects: ["INC"],
			siteUrl: "https://tommy.atlassian.net",
		});
		expect(result.count).toBe(1);
		expect(result.issues[0].key).toBe("INC-1");
		expect(result.issues[0].url).toBe("https://tommy.atlassian.net/browse/INC-1");
		expect(result.issues[0].mttrMinutes).toBe(30);
	});
});
