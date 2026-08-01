// packages/agent/src/correlation/extractors/atlassian.test.ts
// SIO-785 Phase 2: Atlassian linked-incidents extractor.
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractAtlassianFindings } from "./atlassian.ts";

describe("extractAtlassianFindings", () => {
	test("returns empty when no findLinkedIncidents tool outputs", () => {
		const outputs: ToolOutput[] = [{ toolName: "atlassian_searchJiraIssuesUsingJql", rawJson: { issues: [] } }];
		expect(extractAtlassianFindings(outputs)).toEqual({});
	});

	test("maps {service, jql, count, issues[]} envelope to linkedIssues", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					service: "notifications-service",
					jql: "project in (INC) AND labels = ...",
					count: 1,
					issues: [
						{
							key: "INC-101",
							summary: "Notifications outage",
							status: "Resolved",
							severity: "P1",
							createdAt: "2026-05-10T09:00:00Z",
							resolvedAt: "2026-05-10T11:00:00Z",
							mttrMinutes: 120,
							url: "https://tommy.atlassian.net/browse/INC-101",
						},
					],
				},
			},
		]);
		expect(findings.linkedIssues).toHaveLength(1);
		const first = findings.linkedIssues?.[0];
		expect(first?.key).toBe("INC-101");
		expect(first?.status).toBe("Resolved");
		expect(first?.severity).toBe("P1");
		expect(first?.mttrMinutes).toBe(120);
	});

	test("accepts nullable severity / resolvedAt / mttrMinutes (open issue)", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					issues: [
						{
							key: "INC-9",
							summary: "Open issue",
							status: "Open",
							severity: null,
							resolvedAt: null,
							mttrMinutes: null,
						},
					],
				},
			},
		]);
		expect(findings.linkedIssues?.[0]?.severity).toBeNull();
		expect(findings.linkedIssues?.[0]?.resolvedAt).toBeNull();
	});

	test("merges issues across multiple findLinkedIncidents calls (multi-service)", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: { service: "a", jql: "", count: 1, issues: [{ key: "A-1", summary: "A", status: "Open" }] },
			},
			{
				toolName: "findLinkedIncidents",
				rawJson: { service: "b", jql: "", count: 1, issues: [{ key: "B-1", summary: "B", status: "Open" }] },
			},
		]);
		expect(findings.linkedIssues?.map((i) => i.key)).toEqual(["A-1", "B-1"]);
	});

	// SIO-1338 (CodeRabbit, PR #564): two calls probing different services can legitimately
	// return the SAME ticket (matched by both services' domain terms). The merge above has no
	// dedup, so linkedIssues could carry duplicate keys -- AtlassianFindingsCard's keyed
	// {#each ... (issue.key)} block requires unique keys per Svelte's own contract.
	test("dedupes issues sharing the same key across multiple findLinkedIncidents calls", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					service: "orders-service",
					issues: [{ key: "DEVOPS-1", summary: "orders-service consume failure", status: "Backlog" }],
				},
			},
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					service: "corrected-delivery-dates-service",
					// Same underlying ticket, matched again by a different service's domain-term query --
					// this is the exact SIO-1093 cross-service text-match design, not malformed input.
					issues: [{ key: "DEVOPS-1", summary: "orders-service consume failure", status: "Backlog" }],
				},
			},
		]);
		expect(findings.linkedIssues?.map((i) => i.key)).toEqual(["DEVOPS-1"]);
		expect(findings.linkedIssues).toHaveLength(1);
	});

	test("dedup keeps the FIRST occurrence's data when the same key repeats", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					service: "a",
					issues: [{ key: "DEVOPS-1", summary: "first-seen summary", status: "Open" }],
				},
			},
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					service: "b",
					issues: [{ key: "DEVOPS-1", summary: "second-seen summary (stale duplicate)", status: "Resolved" }],
				},
			},
		]);
		expect(findings.linkedIssues?.[0]?.summary).toBe("first-seen summary");
		expect(findings.linkedIssues?.[0]?.status).toBe("Open");
	});

	test("returns empty on no matching tool outputs", () => {
		expect(extractAtlassianFindings([])).toEqual({});
	});

	test("drops malformed issues but keeps valid siblings", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					issues: [{ key: "A-1", summary: "A", status: "Open" }, { foo: "bar" }],
				},
			},
		]);
		expect(findings.linkedIssues).toHaveLength(1);
		expect(findings.linkedIssues?.[0]?.key).toBe("A-1");
	});

	test("ignores non-object rawJson (defensive)", () => {
		expect(extractAtlassianFindings([{ toolName: "findLinkedIncidents", rawJson: "upstream text" }])).toEqual({});
		expect(extractAtlassianFindings([{ toolName: "findLinkedIncidents", rawJson: null }])).toEqual({});
	});
});

// SIO-1338: findLinkedIncidents' own configWarning (SIO-1184 dead-project config, SIO-1337
// pagination truncation) was being discarded here -- the raw JSON carried it, but nothing
// downstream of this extractor (the findings card, the aggregator prompt context) could see it.
describe("extractAtlassianFindings configWarning propagation (SIO-1338)", () => {
	test("propagates configWarning alongside linkedIssues", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					service: "orders-service",
					issues: [{ key: "DEVOPS-1", summary: "x", status: "Open" }],
					configWarning: "More than 1 incidents matched within 30d; results were truncated to the requested limit.",
				},
			},
		]);
		expect(findings.linkedIssues).toHaveLength(1);
		expect(findings.configWarning).toBe(
			"More than 1 incidents matched within 30d; results were truncated to the requested limit.",
		);
	});

	test("propagates configWarning even when linkedIssues is empty", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					service: "orders-service",
					issues: [],
					configWarning: "Configured incident project(s) INC do not exist on this Jira site.",
				},
			},
		]);
		expect(findings.linkedIssues).toBeUndefined();
		expect(findings.configWarning).toBe("Configured incident project(s) INC do not exist on this Jira site.");
	});

	test("dedupes and joins configWarning across multiple calls", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: { service: "a", issues: [{ key: "A-1", summary: "a", status: "Open" }], configWarning: "warn-a" },
			},
			{
				toolName: "findLinkedIncidents",
				rawJson: { service: "b", issues: [{ key: "B-1", summary: "b", status: "Open" }], configWarning: "warn-b" },
			},
			// Same warning text repeated (e.g. two calls hitting the same truncation) must not duplicate.
			{
				toolName: "findLinkedIncidents",
				rawJson: { service: "a", issues: [{ key: "A-2", summary: "a2", status: "Open" }], configWarning: "warn-a" },
			},
		]);
		expect(findings.configWarning).toBe("warn-a warn-b");
	});

	test("omits configWarning entirely when no call set it", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: { service: "a", issues: [{ key: "A-1", summary: "a", status: "Open" }] },
			},
		]);
		expect(findings.configWarning).toBeUndefined();
	});
});

describe("extractAtlassianFindings focus scoping (SIO-1030)", () => {
	const issues = (rows: Array<Record<string, unknown>>): ToolOutput => ({
		toolName: "findLinkedIncidents",
		rawJson: { issues: rows },
	});

	test("empty focus keeps every issue (show-all, back-compat)", () => {
		const out = extractAtlassianFindings(
			[
				issues([
					{ key: "A-1", summary: "prices outage", status: "Open" },
					{ key: "B-1", summary: "kong blip", status: "Open" },
				]),
			],
			[],
		);
		expect(out.linkedIssues).toHaveLength(2);
	});

	test("keeps issues whose summary references the focus, drops unrelated", () => {
		const out = extractAtlassianFindings(
			[
				issues([
					{ key: "INC-1", summary: "prices-api-v2-service returning 500s", status: "Resolved" },
					{ key: "INC-2", summary: "authentication-service latency", status: "Resolved" },
				]),
			],
			["prices-api-v2-service"],
		);
		expect(out.linkedIssues?.map((i) => i.key)).toEqual(["INC-1"]);
	});
});

// SIO-1244: run 43796e9f dropped all 10 Atlassian findings while Atlassian was the most
// load-bearing datasource in the report. Provenance -- the envelope's own `service`, i.e. the
// focus-derived term the sub-agent searched with -- decides before per-issue prose matching.
describe("extractAtlassianFindings provenance scoping (SIO-1244)", () => {
	const envelope = (service: string, rows: Array<Record<string, unknown>>): ToolOutput => ({
		toolName: "findLinkedIncidents",
		rawJson: { service, jql: "...", count: rows.length, issues: rows },
	});

	// The production shape: findLinkedIncidents' JQL matches on labels/component/errorKeywords,
	// so it legitimately returns tickets whose SUMMARY never names the service.
	test("keeps issues retrieved by a focus-scoped query even when no summary names the service", () => {
		const out = extractAtlassianFindings(
			[
				envelope("prana-order-service", [
					{ key: "DEVOPS-1405", summary: "AFS season code mismatch on THE1", status: "Open" },
					{ key: "DEVOPS-1397", summary: "Delivery window calculation regression", status: "Resolved" },
				]),
			],
			["prana-order-service"],
		);
		expect(out.linkedIssues?.map((i) => i.key)).toEqual(["DEVOPS-1405", "DEVOPS-1397"]);
	});

	// The SIO-1030 guarantee: provenance is a guard, not an off-switch. An envelope whose own
	// service is off-focus must NOT smuggle its tickets in.
	test("an off-focus envelope still gets per-issue matching, and unrelated issues drop", () => {
		const out = extractAtlassianFindings(
			[
				envelope("billing-service", [
					{ key: "INC-1", summary: "prana-order-service returning 500s", status: "Open" },
					{ key: "INC-2", summary: "unrelated cache eviction", status: "Open" },
				]),
			],
			["prana-order-service"],
		);
		expect(out.linkedIssues?.map((i) => i.key)).toEqual(["INC-1"]);
	});

	test("matches on the issue KEY as well as the summary", () => {
		const out = extractAtlassianFindings(
			[
				envelope("billing-service", [
					{ key: "PRANA-ORDER-77", summary: "opaque title with no service name", status: "Open" },
					{ key: "OTHER-1", summary: "also opaque", status: "Open" },
				]),
			],
			["prana-order-service"],
		);
		expect(out.linkedIssues?.map((i) => i.key)).toEqual(["PRANA-ORDER-77"]);
	});

	// Back-compat: envelopes without `service` (older captures, other producers) behave exactly
	// as before -- per-issue matching only.
	test("an envelope with no service field falls back to per-issue matching", () => {
		const out = extractAtlassianFindings(
			[
				{
					toolName: "findLinkedIncidents",
					rawJson: {
						issues: [
							{ key: "INC-1", summary: "prana-order-service down", status: "Open" },
							{ key: "INC-2", summary: "unrelated", status: "Open" },
						],
					},
				},
			],
			["prana-order-service"],
		);
		expect(out.linkedIssues?.map((i) => i.key)).toEqual(["INC-1"]);
	});

	test("empty focus keeps everything regardless of envelope service", () => {
		const out = extractAtlassianFindings([envelope("anything", [{ key: "A-1", summary: "x", status: "Open" }])], []);
		expect(out.linkedIssues).toHaveLength(1);
	});
});
