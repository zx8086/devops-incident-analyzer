// test/find-linked-incidents.test.ts
import { describe, expect, test } from "bun:test";
import type { AtlassianMcpProxy } from "../src/atlassian-client/index.js";
import {
	attributeMatch,
	buildJql,
	descriptionExcerpt,
	findLinkedIncidents,
	type JiraIssueRaw,
	shapeIssue,
	WIDENED_WINDOW_DAYS,
} from "../src/tools/custom/find-linked-incidents.js";

describe("findLinkedIncidents.descriptionExcerpt", () => {
	test("collapses whitespace and returns flat text", () => {
		expect(descriptionExcerpt("KV  timeouts\n\nafter   a rebuild")).toBe("KV timeouts after a rebuild");
	});

	test("undefined for absent or empty bodies, never an empty string", () => {
		// The field is optional in the schema; "" would occupy a slot in the model's
		// state and say nothing.
		expect(descriptionExcerpt(undefined)).toBeUndefined();
		expect(descriptionExcerpt(null)).toBeUndefined();
		expect(descriptionExcerpt("   \n  ")).toBeUndefined();
		expect(descriptionExcerpt({})).toBeUndefined();
	});

	test("caps at 600 characters", () => {
		const excerpt = descriptionExcerpt("x".repeat(5000));
		expect(excerpt).toHaveLength(600);
	});

	test("walks ADF for its text nodes instead of stringifying the document", () => {
		// The call asks for markdown, but a site can still answer with ADF. Braces and
		// key names in a JSON.stringify would be noise a reader has to see through.
		const adf = {
			type: "doc",
			version: 1,
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Consumers hit an ambiguous timeout" }] },
				{ type: "paragraph", content: [{ type: "text", text: "on KV get." }] },
			],
		};
		const excerpt = descriptionExcerpt(adf);
		expect(excerpt).toBe("Consumers hit an ambiguous timeout on KV get.");
		expect(excerpt).not.toContain("paragraph");
		expect(excerpt).not.toContain("{");
	});
});

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

	test("SIO-1837: carries a description excerpt, absent when there is no description", () => {
		const withBody = shapeIssue({
			key: "INC-5",
			fields: {
				summary: "s",
				status: { name: "Open" },
				created: "2026-04-10T10:00:00Z",
				description: "KV  timeouts\nafter an index rebuild",
			},
		});
		// Whitespace collapsed so the excerpt reads as one line.
		expect(withBody.descriptionExcerpt).toBe("KV timeouts after an index rebuild");

		const withoutBody = shapeIssue({
			key: "INC-6",
			fields: { summary: "s", status: { name: "Open" }, created: "2026-04-10T10:00:00Z" },
		});
		expect(withoutBody.descriptionExcerpt).toBeUndefined();
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

	// Greptile, PR #831: Jira matches a phrase across whatever separates its words, so a
	// literal substring test missed real hits and, with attribution now a filter, a missed hit
	// can drop a relevant ticket. Reproduced before fixing: the first three lost `kv timeout`.
	test("a phrase is found across a newline, Markdown emphasis, repeated spaces and code ticks", () => {
		for (const description of [
			"GetRequest failed with a kv\ntimeout on the bucket",
			"GetRequest failed with a **kv** timeout on the bucket",
			"GetRequest failed with a kv  timeout on the bucket",
			"`GetRequest` failed with a `kv timeout`",
		]) {
			const out = attributeMatch(issue({ description }), {
				service: "styles-service",
				errorKeywords: ["kv timeout", "GetRequest"],
			});
			expect(out.matchedBy).toEqual(["keyword:kv timeout", "keyword:GetRequest"]);
		}
	});

	// Greptile, PR #831 round 2: anchoring only the START let `api` hit `apiary`, and a false
	// service-text hit is structural, so it bypassed the weak-hit filter entirely.
	test("a term needs a word boundary on both sides; only a plural is tolerated", () => {
		const t = { service: "api", errorKeywords: ["timeout"] };
		expect(attributeMatch(issue({ summary: "capital expenditure report" }), t).matchedBy).toEqual([]);
		expect(attributeMatch(issue({ summary: "apiary docs and a timeoutless retry" }), t).matchedBy).toEqual([]);
		expect(
			attributeMatch(issue({ summary: "kv timeout", description: "x" }), { service: "s", errorKeywords: ["kv time"] })
				.matchedBy,
		).toEqual([]);
		expect(attributeMatch(issue({ summary: "three timeouts on the api gateway" }), t).matchedBy).toEqual([
			"service-text",
			"keyword:timeout",
		]);
	});

	test("a hyphenated service name is found however the ticket punctuates it", () => {
		const out = attributeMatch(issue({ summary: "Incident Report: pvh_services.styles-v3 down" }), {
			service: "pvh-services-styles-v3",
		});
		expect(out.matchedBy).toEqual(["service-text"]);
	});

	test("a null or non-text description does not throw", () => {
		expect(attributeMatch(issue({ description: null }), terms).score).toBe(0);
		expect(attributeMatch(issue({ description: { type: "doc", content: [] } }), terms).score).toBe(0);
	});
});

// SIO-1802, found on the live replay AFTER the first fix merged: the model passed generic
// single-word keywords (`article`, `styles`, `kv`). In one OR under `created DESC` they
// matched 1,043 tickets, today's junk took all 10 slots, the focus service's own incidents
// never came back, and the card (correctly) dropped all 10 and showed nothing. The service
// query alone returned exactly the related tickets, so the two halves are searched apart.
describe("findLinkedIncidents searches service and keywords separately (SIO-1802)", () => {
	const args = { service: "styles-service", componentLabel: undefined, withinDays: 90, incidentProjects: [] };

	test("buildJql can emit each half; the default is still the SIO-1093 OR of both", () => {
		const keywords = ["article", "kv timeout"];
		const service = buildJql({ ...args, errorKeywords: keywords, match: "service" });
		expect(service).toContain('labels = "styles-service"');
		expect(service).not.toContain("article");
		const kw = buildJql({ ...args, errorKeywords: keywords, match: "keywords" });
		expect(kw).toContain('text ~ "article"');
		expect(kw).toContain('text ~ "\\"kv timeout\\""');
		expect(kw).not.toContain("labels =");
		const all = buildJql({ ...args, errorKeywords: keywords });
		expect(all).toContain('labels = "styles-service"');
		expect(all).toContain('text ~ "article"');
		// "keywords" with nothing to search falls back to the full shape rather than `()`.
		expect(buildJql({ ...args, match: "keywords" })).toContain('labels = "styles-service"');
	});

	const row = (key: string, summary: string) => ({
		key,
		fields: { summary, status: { name: "Open" }, created: "2026-04-10T10:00:00Z" },
	});
	const proxyFor = (calls: string[]) =>
		({
			callTool: async (_name: string, a: Record<string, unknown>) => {
				const jql = String(a.jql);
				calls.push(jql);
				const issues = jql.includes("labels =")
					? [row("SVC-1", "Incident Report: styles-service kv timeout"), row("SVC-2", "styles-service 404")]
					: Array.from({ length: 10 }, (_, i) => row(`JUNK-${i}`, `Article Master routing ${i}`));
				return {
					content: [
						{ type: "text", text: JSON.stringify({ issues, isLast: !jql.includes("labels =") ? false : true }) },
					],
				};
			},
		}) as unknown as Parameters<typeof findLinkedIncidents>[0];

	test("generic keyword hits cannot crowd the service's own incidents out of the limit", async () => {
		const calls: string[] = [];
		const out = await findLinkedIncidents(proxyFor(calls), {
			service: "styles-service",
			errorKeywords: ["article", "kv timeout"],
			withinDays: 90,
			limit: 10,
			incidentProjects: [],
		});
		expect(calls).toHaveLength(2);
		expect(out.jql).toContain('labels = "styles-service"');
		expect(out.keywordJql).toContain('text ~ "article"');
		expect(out.issues).toHaveLength(10);
		expect(out.issues.slice(0, 2).map((i) => i.key)).toEqual(["SVC-1", "SVC-2"]);
		expect(out.issues[0]?.matchedBy).toEqual(["service-text", "keyword:kv timeout"]);
		expect(out.issues.slice(2).every((i) => i.matchedBy.join() === "keyword:article")).toBe(true);
		// The keyword query was truncated upstream, and that still surfaces.
		expect(out.configWarning).toContain("truncated");
	});

	test("without keywords there is one query and no keywordJql", async () => {
		const calls: string[] = [];
		const out = await findLinkedIncidents(proxyFor(calls), {
			service: "styles-service",
			withinDays: 90,
			limit: 10,
			incidentProjects: [],
		});
		expect(calls).toHaveLength(1);
		expect(out.keywordJql).toBeUndefined();
		expect(out.issues.map((i) => i.key)).toEqual(["SVC-1", "SVC-2"]);
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
				// Each query's own upstream order is created DESC. The keyword query also
				// returns OLD-1, which must not appear twice.
				const issues = String(args.jql).includes("labels =")
					? [
							row("OLD-1", "Incident Report: styles-service -- kv timeout"),
							row("OLD-2", "labelled only", ["styles-service"]),
						]
					: [
							row("NEW-1", "unrelated marketing story"),
							row("NEW-2", "another unrelated story"),
							row("OLD-1", "Incident Report: styles-service -- kv timeout"),
						];
				return { content: [{ type: "text", text: JSON.stringify({ issues, isLast: true }) }] };
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

// Greptile, PR #832: both findings were about the split itself.
describe("findLinkedIncidents: the two queries fail independently and service hits lead (SIO-1802)", () => {
	const row = (key: string, summary: string) => ({
		key,
		fields: { summary, status: { name: "Open" }, created: "2026-04-10T10:00:00Z" },
	});
	const ok = (issues: unknown[]) => ({ content: [{ type: "text", text: JSON.stringify({ issues, isLast: true }) }] });
	type Reply = ReturnType<typeof ok> | Error;
	const proxyWith = (service: Reply, keywords: Reply) =>
		({
			callTool: async (_name: string, a: Record<string, unknown>) => {
				const reply = String(a.jql).includes("labels =") ? service : keywords;
				if (reply instanceof Error) throw reply;
				return reply;
			},
		}) as unknown as Parameters<typeof findLinkedIncidents>[0];
	const ctx = {
		service: "styles-service",
		errorKeywords: ["article", "styles", "kv"],
		withinDays: 90,
		limit: 3,
		incidentProjects: [],
	};

	test("a keyword-only ticket with three generic keywords never outranks a service hit", async () => {
		const out = await findLinkedIncidents(
			proxyWith(
				ok([row("SVC-1", "styles-service 404"), row("SVC-2", "styles-service slow")]),
				ok([row("JUNK-1", "article styles kv migration"), row("JUNK-2", "article kv")]),
			),
			ctx,
		);
		// JUNK-1 scores 3, the service hits 2 and 3; with limit 3 a global sort would have
		// put JUNK-1 first and could cut a service hit.
		expect(out.issues.map((i) => i.key)).toEqual(["SVC-1", "SVC-2", "JUNK-1"]);
	});

	test("a service hit whose match is invisible to attribution is still marked, not scored 0", async () => {
		const out = await findLinkedIncidents(
			proxyWith(ok([row("SVC-9", "opaque summary, service named only in a comment")]), ok([])),
			ctx,
		);
		expect(out.issues[0]).toMatchObject({ key: "SVC-9", matchedBy: ["service-text"], score: 2 });
	});

	test("a throwing keyword query keeps the service hits and says so", async () => {
		const out = await findLinkedIncidents(
			proxyWith(ok([row("SVC-1", "styles-service 404")]), new Error("upstream 503")),
			ctx,
		);
		expect(out.issues.map((i) => i.key)).toEqual(["SVC-1"]);
		expect(out.configWarning).toContain("keyword search failed");
	});

	test("an unusable service query is never a silent keyword-only result", async () => {
		const unparseable = { content: [{ type: "text", text: "<html>gateway timeout</html>" }] } as unknown as Reply;
		for (const service of [new Error("upstream 503"), unparseable]) {
			const out = await findLinkedIncidents(proxyWith(service, ok([row("KW-1", "article kv")])), ctx);
			expect(out.issues.map((i) => i.key)).toEqual(["KW-1"]);
			expect(out.configWarning).toContain("naming styles-service failed");
		}
	});

	test("both queries throwing stays loud, as the single query was (SIO-1116)", async () => {
		await expect(
			findLinkedIncidents(proxyWith(new Error("service down"), new Error("keywords down")), ctx),
		).rejects.toThrow("service down");
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

// SIO-1863: an empty result at the default window is usually the WINDOW, not the query.
// Measured live: `pvh-services-styles-v3` returned 0 at 30d and 10 at 120d, and those 10 name
// the service verbatim in their summaries -- they were 53 days old. The rerank then kept 8 of
// 10. Recency was hiding good evidence.
describe("SIO-1863: widen the window once when nothing matches", () => {
	const report = (key: string) => ({
		key,
		fields: {
			summary: `Incident Report: pvh-services-styles-v3 — Couchbase timeout ${key}`,
			status: { name: "Closed" },
			created: "2026-07-30T21:11:57.148+0100",
		},
	});

	// Returns nothing inside 30 days and the real incident reports at the widened window,
	// which is exactly what the live Jira does for this service.
	const proxyByWindow = (seen: string[]) =>
		({
			callTool: async (_name: string, a: Record<string, unknown>) => {
				const jql = String(a.jql);
				seen.push(jql);
				const wide = jql.includes(`-${WIDENED_WINDOW_DAYS}d`);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								issues: wide ? [report("DEVOPS-1413"), report("DEVOPS-1412")] : [],
								isLast: true,
							}),
						},
					],
				};
			},
		}) as unknown as Parameters<typeof findLinkedIncidents>[0];

	test("an empty narrow window retries wider and returns the older reports", async () => {
		const seen: string[] = [];
		const out = await findLinkedIncidents(proxyByWindow(seen), {
			service: "pvh-services-styles-v3",
			withinDays: 30,
			limit: 10,
			incidentProjects: [],
		});

		expect(out.count).toBe(2);
		expect(out.issues.map((i) => i.key)).toEqual(["DEVOPS-1413", "DEVOPS-1412"]);
		// The caller must be able to tell these are outside the window it asked for.
		expect(out.configWarning).toContain(`widened to ${WIDENED_WINDOW_DAYS}d`);
		expect(seen.some((j) => j.includes("-30d"))).toBe(true);
		expect(seen.some((j) => j.includes(`-${WIDENED_WINDOW_DAYS}d`))).toBe(true);
	});

	test("a window that already returns hits is NOT widened", async () => {
		const seen: string[] = [];
		const proxy = {
			callTool: async (_name: string, a: Record<string, unknown>) => {
				seen.push(String(a.jql));
				return {
					content: [{ type: "text", text: JSON.stringify({ issues: [report("DEVOPS-1500")], isLast: true }) }],
				};
			},
		} as unknown as Parameters<typeof findLinkedIncidents>[0];

		const out = await findLinkedIncidents(proxy, {
			service: "kafka",
			withinDays: 30,
			limit: 10,
			incidentProjects: [],
		});

		expect(out.count).toBe(1);
		expect(out.configWarning).toBeUndefined();
		// One search only: no retry, so a service that already works costs nothing extra.
		expect(seen).toHaveLength(1);
		expect(seen.every((j) => j.includes("-30d"))).toBe(true);
	});

	test("a genuinely empty corpus retries once and then stops", async () => {
		const seen: string[] = [];
		const proxy = {
			callTool: async (_name: string, a: Record<string, unknown>) => {
				seen.push(String(a.jql));
				return { content: [{ type: "text", text: JSON.stringify({ issues: [], isLast: true }) }] };
			},
		} as unknown as Parameters<typeof findLinkedIncidents>[0];

		const out = await findLinkedIncidents(proxy, {
			service: "nothing-matches-this",
			withinDays: 30,
			limit: 10,
			incidentProjects: [],
		});

		expect(out.count).toBe(0);
		// Bounded: the narrow search plus exactly one wider retry, never a loop.
		expect(seen).toHaveLength(2);
		// An empty result reports the window the CALLER asked for, not the retry's.
		expect(out.jql).toContain("-30d");
	});
});
