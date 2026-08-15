// agent/src/iac/renovate-integration.test.ts
import { describe, expect, test } from "bun:test";
import { buildRenovateGateMessage, parseRenovateTargetJson } from "./nodes.ts";

describe("buildRenovateGateMessage", () => {
	test("names the exact marker and describes the trigger", () => {
		const msg = buildRenovateGateMessage({
			marker: "renovate/eu-b2b-prometheus",
			line: " - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4",
		});
		expect(msg).toContain("renovate/eu-b2b-prometheus");
		expect(msg).toContain("chore(deps): [eu-b2b] prometheus to v1.24.4");
	});
});

// Renovate on-demand MR automation: extractRenovateTarget's LLM call returns a JSON
// object with deployment+integration; parseRenovateTargetJson validates and normalizes
// it, returning null on malformed/incomplete output so the node can clarify instead of
// silently guessing.
describe("parseRenovateTargetJson", () => {
	test("parses a well-formed extraction", () => {
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b","integration":"prometheus"}')).toEqual({
			deployment: "eu-b2b",
			integration: "prometheus",
		});
	});

	test("null when deployment is missing", () => {
		expect(parseRenovateTargetJson('{"integration":"prometheus"}')).toBeNull();
	});

	test("null when integration is missing", () => {
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b"}')).toBeNull();
	});

	test("null when either field is an empty string", () => {
		expect(parseRenovateTargetJson('{"deployment":"","integration":"prometheus"}')).toBeNull();
		expect(parseRenovateTargetJson('{"deployment":"eu-b2b","integration":""}')).toBeNull();
	});

	test("null on malformed JSON", () => {
		expect(parseRenovateTargetJson("not json")).toBeNull();
	});

	test("tolerates surrounding prose (extracts the JSON block)", () => {
		expect(
			parseRenovateTargetJson('Here is the extraction: {"deployment":"ap-cld","integration":"cisco_ftd"} done.'),
		).toEqual({ deployment: "ap-cld", integration: "cisco_ftd" });
	});
});

import { filterDashboardMatches, hasSingleRenovateMatch, parseRenovateDashboardEntries } from "./nodes.ts";

describe("parseRenovateDashboardEntries", () => {
	test("extracts marker+line pairs", () => {
		const body =
			" - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4\n";
		expect(parseRenovateDashboardEntries(body)).toEqual([
			{
				marker: "renovate/eu-b2b-prometheus",
				line: " - [ ] <!-- unschedule-branch=renovate/eu-b2b-prometheus -->chore(deps): [eu-b2b] prometheus to v1.24.4",
			},
		]);
	});

	test("empty array on a body with no marker lines", () => {
		expect(parseRenovateDashboardEntries("nothing here")).toEqual([]);
	});
});

describe("filterDashboardMatches", () => {
	const entries = [
		{ marker: "renovate/eu-b2b-prometheus", line: "chore(deps): [eu-b2b] prometheus to v1.24.4" },
		{ marker: "renovate/ap-cld-prometheus", line: "chore(deps): [ap-cld] prometheus to v1.24.4" },
		{ marker: "renovate/eu-b2b-cisco_ftd", line: "chore(deps): [eu-b2b] cisco_ftd to v3.13.10" },
	];

	test("returns the single entry matching both deployment and integration (case-insensitive)", () => {
		expect(filterDashboardMatches(entries, "eu-b2b", "PROMETHEUS")).toEqual([
			{ marker: "renovate/eu-b2b-prometheus", line: "chore(deps): [eu-b2b] prometheus to v1.24.4" },
		]);
	});

	test("returns multiple entries when the integration alone matches across deployments", () => {
		expect(filterDashboardMatches(entries, "", "prometheus")).toHaveLength(2);
	});

	test("empty array when nothing matches", () => {
		expect(filterDashboardMatches(entries, "us-cld", "netskope")).toEqual([]);
	});
});

describe("hasSingleRenovateMatch (graph-edge predicate)", () => {
	test("true for exactly one candidate", () => {
		expect(hasSingleRenovateMatch([{ marker: "renovate/eu-b2b-prometheus", line: "x" }])).toBe(true);
	});
	test("false for zero candidates", () => {
		expect(hasSingleRenovateMatch([])).toBe(false);
	});
	test("false for 2+ candidates (ambiguous)", () => {
		expect(
			hasSingleRenovateMatch([
				{ marker: "renovate/eu-b2b-prometheus", line: "x" },
				{ marker: "renovate/ap-cld-prometheus", line: "y" },
			]),
		).toBe(false);
	});
});

import { parseFirstIssueIid, parseIssueDescription } from "./nodes.ts";

// gitlab_search (scope: work_items) response shape: an array of GitLab search-result
// objects. Only the numeric `iid` field is needed here.
describe("parseFirstIssueIid", () => {
	test("returns the iid of the first result", () => {
		const raw = JSON.stringify([{ iid: 11, title: "Elastic Fleet & Agent Dependency Dashboard" }]);
		expect(parseFirstIssueIid(raw)).toBe(11);
	});

	test("null on an empty array (no dashboard issue found)", () => {
		expect(parseFirstIssueIid("[]")).toBeNull();
	});

	test("null on malformed JSON", () => {
		expect(parseFirstIssueIid("not json")).toBeNull();
	});

	test("null when the first result has no numeric iid", () => {
		expect(parseFirstIssueIid(JSON.stringify([{ title: "no iid here" }]))).toBeNull();
	});
});

// gitlab_get_issue response shape: a single issue object with a `description` field.
describe("parseIssueDescription", () => {
	test("returns the description field", () => {
		const raw = JSON.stringify({ iid: 11, description: "## Awaiting Schedule\n\n - [ ] ..." });
		expect(parseIssueDescription(raw)).toBe("## Awaiting Schedule\n\n - [ ] ...");
	});

	test("empty string when description is missing", () => {
		expect(parseIssueDescription(JSON.stringify({ iid: 11 }))).toBe("");
	});

	test("empty string on malformed JSON", () => {
		expect(parseIssueDescription("not json")).toBe("");
	});
});
