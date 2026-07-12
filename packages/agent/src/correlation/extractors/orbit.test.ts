// packages/agent/src/correlation/extractors/orbit.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractOrbitFindings } from "./orbit.ts";

// Mirrors the real Orbit REST envelope: the tool wrapper stamps queryTag and
// passes through { result: { rows: [...] } }. Traversal rows are node-keyed
// { alias: { type, id, properties } }; aggregation rows are scalar/count columns.

function out(toolName: string, rawJson: unknown): ToolOutput {
	return { toolName, rawJson } as ToolOutput;
}

describe("extractOrbitFindings", () => {
	test("blast radius: groups by definition, collects downstream import sites", () => {
		const raw = {
			queryTag: "orbit_blast_radius",
			result: {
				rows: [
					{
						def: {
							type: "Definition",
							id: "1",
							properties: {
								fqn: "Auth::verify",
								file_path: "pvhcorp/auth-lib/src/verify.rb",
								definition_type: "method",
							},
						},
						sym: {
							type: "ImportedSymbol",
							id: "2",
							properties: { file_path: "pvhcorp/checkout/app.rb", import_path: "pvhcorp/auth-lib/verify" },
						},
					},
					{
						def: {
							type: "Definition",
							id: "1",
							properties: { fqn: "Auth::verify", file_path: "pvhcorp/auth-lib/src/verify.rb" },
						},
						sym: {
							type: "ImportedSymbol",
							id: "3",
							properties: { file_path: "pvhcorp/orders/handler.rb", import_path: "pvhcorp/auth-lib/verify" },
						},
					},
				],
			},
		};
		const findings = extractOrbitFindings([out("gitlab_blast_radius", raw)]);
		expect(findings.blastRadius).toHaveLength(1);
		const b = findings.blastRadius?.[0];
		expect(b?.definitionName).toBe("Auth::verify");
		expect(b?.importSiteCount).toBe(2);
		expect(b?.importedByProjects).toContain("pvhcorp/checkout");
		expect(b?.importedByProjects).toContain("pvhcorp/orders");
	});

	test("recent deploys: maps mr + project nodes, keeps merged_at + id", () => {
		const raw = {
			queryTag: "orbit_recent_deploys",
			result: {
				rows: [
					{
						mr: {
							type: "MergeRequest",
							id: "10",
							properties: { id: "10", iid: "5", title: "bump auth-lib", merged_at: "2026-07-01T10:00:00Z" },
						},
						p: { type: "Project", id: "20", properties: { full_path: "pvhcorp/checkout" } },
					},
				],
			},
		};
		const findings = extractOrbitFindings([out("gitlab_recent_deploys", raw)]);
		expect(findings.recentDeploys).toHaveLength(1);
		expect(findings.recentDeploys?.[0]?.mergedAt).toBe("2026-07-01T10:00:00Z");
		expect(findings.recentDeploys?.[0]?.project).toBe("pvhcorp/checkout");
	});

	test("pipeline failures: aggregation rows with scalar buckets + count column", () => {
		const raw = {
			queryTag: "orbit_pipeline_failures",
			result: {
				rows: [
					{ project: "pvhcorp/checkout", ref: "main", failures: 12 },
					{ project: "pvhcorp/orders", ref: "main", failures: 3 },
				],
			},
		};
		const findings = extractOrbitFindings([out("gitlab_pipeline_failures", raw)]);
		expect(findings.pipelineFailures).toHaveLength(2);
		expect(findings.pipelineFailures?.[0]?.failureCount).toBe(12);
	});

	test("vulnerabilities: critical/high severity from v + p nodes", () => {
		const raw = {
			queryTag: "orbit_vulns_recent_mr",
			result: {
				rows: [
					{
						v: {
							type: "Vulnerability",
							id: "99",
							properties: { title: "SQLi", severity: "critical", report_type: "sast" },
						},
						p: { type: "Project", id: "20", properties: { full_path: "pvhcorp/checkout" } },
					},
				],
			},
		};
		const findings = extractOrbitFindings([out("gitlab_recent_vulnerabilities", raw)]);
		expect(findings.vulnerabilities).toHaveLength(1);
		expect(findings.vulnerabilities?.[0]?.severity).toBe("critical");
	});

	test("focus filtering: drops off-focus blast-radius rows", () => {
		const raw = {
			queryTag: "orbit_blast_radius",
			result: {
				rows: [
					{
						def: { properties: { fqn: "Auth::verify", file_path: "pvhcorp/auth-lib/verify.rb" } },
						sym: { properties: { file_path: "pvhcorp/checkout/app.rb", import_path: "pvhcorp/auth-lib/verify" } },
					},
				],
			},
		};
		// Focus on a service the row does not reference -> dropped.
		expect(extractOrbitFindings([out("gitlab_blast_radius", raw)], ["payments"]).blastRadius).toBeUndefined();
		// Focus on a service the row references -> kept.
		expect(extractOrbitFindings([out("gitlab_blast_radius", raw)], ["checkout"]).blastRadius).toHaveLength(1);
	});

	test("non-orbit tools and empty rows produce no findings", () => {
		expect(extractOrbitFindings([out("gitlab_list_merge_requests", { some: "thing" })])).toEqual({});
		expect(
			extractOrbitFindings([out("gitlab_blast_radius", { queryTag: "orbit_blast_radius", result: { rows: [] } })]),
		).toEqual({});
	});

	test("raw escape hatch (unknown tag) yields no typed findings", () => {
		const raw = { result: { rows: [{ p: { properties: { full_path: "pvhcorp/x" } } }] } };
		expect(extractOrbitFindings([out("gitlab_orbit_query_graph", raw)])).toEqual({});
	});
});
