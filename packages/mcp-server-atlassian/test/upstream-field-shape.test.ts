// test/upstream-field-shape.test.ts
// SIO-1805: both Jira composers computed MTTR from `resolutiondate`, and neither asked for
// it. The upstream returns a DEFAULT field set when `fields` is omitted, and that set has
// `resolution` but not `resolutiondate` (checked live on resolved tickets), so MTTR was null
// for every ticket. The other tests could not see it: their fixtures hand the tools a
// `resolutiondate` directly, which certifies the arithmetic and not the request.
//
// The fake below behaves like the real upstream instead: it returns ONLY the requested
// fields, and the real default set when none are requested.
import { describe, expect, test } from "bun:test";
import { findLinkedIncidents, LINKED_INCIDENT_FIELDS } from "../src/tools/custom/find-linked-incidents.js";
import { getIncidentHistory, INCIDENT_HISTORY_FIELDS } from "../src/tools/custom/get-incident-history.js";

// As returned live on 2026-09-18 with `fields` omitted.
const UPSTREAM_DEFAULT_FIELDS = [
	"summary",
	"description",
	"status",
	"issuetype",
	"priority",
	"labels",
	"components",
	"assignee",
	"reporter",
	"created",
	"updated",
	"resolution",
	"project",
];

const STORED_ISSUE = {
	key: "INC-1",
	fields: {
		summary: "Incident Report: styles-service kv timeout",
		description: "GetRequest timed out",
		status: { name: "Done" },
		issuetype: { name: "Incident" },
		priority: { name: "High" },
		labels: [],
		components: [],
		assignee: null,
		reporter: null,
		created: "2026-07-13T10:00:00.000+0000",
		updated: "2026-07-15T08:00:00.000+0000",
		resolution: { name: "Done" },
		resolutiondate: "2026-07-13T12:30:00.000+0000",
		project: { key: "INC" },
	},
};

function upstreamLike(requests: Array<Record<string, unknown>>) {
	return {
		callTool: async (_name: string, args: Record<string, unknown>) => {
			requests.push(args);
			const wanted = Array.isArray(args.fields) && args.fields.length > 0 ? args.fields : UPSTREAM_DEFAULT_FIELDS;
			const fields = Object.fromEntries(Object.entries(STORED_ISSUE.fields).filter(([k]) => wanted.includes(k)));
			return {
				content: [
					{ type: "text", text: JSON.stringify({ issues: [{ key: STORED_ISSUE.key, fields }], isLast: true }) },
				],
			};
		},
	} as unknown as Parameters<typeof findLinkedIncidents>[0];
}

describe("the Jira composers ask the upstream for every field they read (SIO-1805)", () => {
	test("the fake reproduces the defect: with no `fields`, a resolved ticket has no resolutiondate", async () => {
		const out = await upstreamLike([]).callTool("searchJiraIssuesUsingJql", { jql: "x" });
		const issue = JSON.parse((out as { content: Array<{ text: string }> }).content[0]?.text ?? "{}").issues[0];
		expect(issue.fields.resolution).toEqual({ name: "Done" });
		expect("resolutiondate" in issue.fields).toBe(false);
	});

	test("findLinkedIncidents gets a resolved ticket's resolvedAt and MTTR", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const out = await findLinkedIncidents(upstreamLike(requests), {
			service: "styles-service",
			withinDays: 90,
			limit: 10,
			incidentProjects: [],
		});
		expect(requests[0]?.fields).toEqual([...LINKED_INCIDENT_FIELDS]);
		expect(out.issues[0]).toMatchObject({
			key: "INC-1",
			status: "Done",
			severity: "High",
			resolvedAt: "2026-07-13T12:30:00.000+0000",
			mttrMinutes: 150,
			matchedBy: ["service-text"],
		});
	});

	test("the keyword query asks for the same fields", async () => {
		const requests: Array<Record<string, unknown>> = [];
		await findLinkedIncidents(upstreamLike(requests), {
			service: "styles-service",
			errorKeywords: ["kv timeout"],
			withinDays: 90,
			limit: 10,
			incidentProjects: [],
		});
		expect(requests).toHaveLength(2);
		for (const r of requests) expect(r.fields).toEqual([...LINKED_INCIDENT_FIELDS]);
	});

	test("getIncidentHistory counts the ticket as resolved and reports its MTTR", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const out = await getIncidentHistory(upstreamLike(requests), {
			service: "styles-service",
			windowDays: 365,
			groupBy: "month",
			incidentProjects: [],
		});
		expect(requests[0]?.fields).toEqual([...INCIDENT_HISTORY_FIELDS]);
		expect(out.totals).toMatchObject({ incidentCount: 1, unresolvedCount: 0, mttrMinutes: 150 });
	});

	// An explicit list REPLACES the upstream default, so a field a tool reads but does not
	// request silently becomes undefined. These pin the lists to what the code reads.
	test("the requested lists cover every field the tools read", () => {
		for (const f of [
			"summary",
			"status",
			"priority",
			"created",
			"resolutiondate",
			"labels",
			"components",
			"description",
		]) {
			expect(LINKED_INCIDENT_FIELDS as readonly string[]).toContain(f);
		}
		for (const f of ["created", "resolutiondate"]) expect(INCIDENT_HISTORY_FIELDS as readonly string[]).toContain(f);
	});
});
