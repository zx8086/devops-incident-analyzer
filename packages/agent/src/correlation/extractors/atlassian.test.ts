// packages/agent/src/correlation/extractors/atlassian.test.ts
// SIO-785 Phase 2: Atlassian linked-incidents extractor.
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractAtlassianFindings } from "./atlassian.ts";

describe("extractAtlassianFindings", () => {
	test("returns empty when no findLinkedIncidents tool outputs", () => {
		const outputs: ToolOutput[] = [
			{ toolName: "atlassian_searchJiraIssuesUsingJql", rawJson: { issues: [] } },
		];
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

	test("returns empty on no matching tool outputs", () => {
		expect(extractAtlassianFindings([])).toEqual({});
	});

	test("drops malformed issues but keeps valid siblings", () => {
		const findings = extractAtlassianFindings([
			{
				toolName: "findLinkedIncidents",
				rawJson: {
					issues: [
						{ key: "A-1", summary: "A", status: "Open" },
						{ foo: "bar" },
					],
				},
			},
		]);
		expect(findings.linkedIssues).toHaveLength(1);
		expect(findings.linkedIssues?.[0]?.key).toBe("A-1");
	});

	test("ignores non-object rawJson (defensive)", () => {
		expect(
			extractAtlassianFindings([{ toolName: "findLinkedIncidents", rawJson: "upstream text" }]),
		).toEqual({});
		expect(extractAtlassianFindings([{ toolName: "findLinkedIncidents", rawJson: null }])).toEqual({});
	});
});
