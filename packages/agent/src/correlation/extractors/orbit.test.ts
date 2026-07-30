// packages/agent/src/correlation/extractors/orbit.test.ts
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractOrbitFindings } from "./orbit.ts";

// Mirrors the real Orbit REST envelope: the tool wrapper stamps queryTag and
// passes through { result: { rows: [...] } }. Traversal rows are node-keyed
// { alias: { type, id, properties } }; aggregation rows are scalar/count columns.

function out(toolName: string, rawJson: unknown): ToolOutput {
	return { toolName, rawJson } as Partial<ToolOutput> as unknown as ToolOutput;
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

	test("blast radius: stitches MR metadata from the enrichment mrByFile map", () => {
		const raw = {
			queryTag: "orbit_blast_radius",
			result: {
				rows: [
					{
						def: { properties: { fqn: "Auth::verify", file_path: "pvhcorp/auth-lib/src/verify.rb" } },
						sym: { properties: { file_path: "pvhcorp/checkout/app.rb", import_path: "pvhcorp/auth-lib/verify" } },
					},
				],
			},
			// The tool's second (enrichment) query result, keyed by source file.
			mrByFile: {
				"pvhcorp/auth-lib/src/verify.rb": {
					type: "MergeRequest",
					id: "42",
					properties: { id: "42", merged_at: "2026-07-05T09:00:00Z", web_url: "https://gitlab.com/mr/42" },
				},
			},
		};
		const b = extractOrbitFindings([out("gitlab_blast_radius", raw)]).blastRadius?.[0];
		expect(b?.mrMergedAt).toBe("2026-07-05T09:00:00Z");
		expect(b?.mrId).toBe("42");
		expect(b?.mrWebUrl).toBe("https://gitlab.com/mr/42");
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
			queryTag: "orbit_recent_vulnerabilities",
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

	// SIO-1303: definition name-match fallback rows carry only `def` (no `sym`/IMPORTS
	// edge). These are name co-occurrences across repos, not confirmed import sites --
	// importSiteCount/importedByFiles/importedByProjects must stay empty, and the
	// finding must be stamped radiusMode so downstream consumers can tell edge-radius
	// findings apart from name-match findings.
	describe("definition name-match fallback (radiusMode)", () => {
		test("radiusMode rows populate definitionName but NOT importSiteCount/importedByFiles/importedByProjects", () => {
			const raw = {
				queryTag: "orbit_blast_radius",
				radiusMode: "definition-name-match",
				result: {
					rows: [
						{
							def: {
								properties: {
									fqn: "StyleController#getStyleByStyleCode",
									file_path: "pvh/services/styles/controller/StyleController.java",
									definition_type: "method",
								},
							},
						},
					],
				},
			};
			const findings = extractOrbitFindings([out("gitlab_blast_radius", raw)]);
			expect(findings.blastRadius).toHaveLength(1);
			const b = findings.blastRadius?.[0];
			expect(b?.definitionName).toBe("StyleController#getStyleByStyleCode");
			expect(b?.radiusMode).toBe("definition-name-match");
			expect(b?.importSiteCount).toBe(0);
			expect(b?.importedByFiles).toEqual([]);
			expect(b?.importedByProjects).toEqual([]);
		});

		test("radiusMode rows still stitch MR metadata from mrByFile", () => {
			const raw = {
				queryTag: "orbit_blast_radius",
				radiusMode: "definition-name-match",
				result: {
					rows: [{ def: { properties: { fqn: "X", file_path: "a.java" } } }],
				},
				mrByFile: {
					"a.java": { properties: { id: "9", merged_at: "2026-07-20T00:00:00Z" } },
				},
			};
			const b = extractOrbitFindings([out("gitlab_blast_radius", raw)]).blastRadius?.[0];
			expect(b?.mrId).toBe("9");
			expect(b?.mrMergedAt).toBe("2026-07-20T00:00:00Z");
		});

		test("multiple name-match rows for distinct definitions produce distinct findings, none with an import count", () => {
			const raw = {
				queryTag: "orbit_blast_radius",
				radiusMode: "definition-name-match",
				result: {
					rows: [
						{ def: { properties: { fqn: "A", file_path: "a.java" } } },
						{ def: { properties: { fqn: "B", file_path: "b.java" } } },
					],
				},
			};
			const findings = extractOrbitFindings([out("gitlab_blast_radius", raw)]);
			expect(findings.blastRadius).toHaveLength(2);
			for (const b of findings.blastRadius ?? []) {
				expect(b.importSiteCount).toBe(0);
				expect(b.radiusMode).toBe("definition-name-match");
			}
		});

		test("absent radiusMode keeps the existing edge-confirmed importSiteCount behavior", () => {
			const raw = {
				queryTag: "orbit_blast_radius",
				result: {
					rows: [
						{
							def: { properties: { fqn: "Auth::verify", file_path: "a.rb" } },
							sym: { properties: { file_path: "checkout/app.rb" } },
						},
					],
				},
			};
			const b = extractOrbitFindings([out("gitlab_blast_radius", raw)]).blastRadius?.[0];
			expect(b?.radiusMode).toBeUndefined();
			expect(b?.importSiteCount).toBe(1);
			expect(b?.importedByFiles).toHaveLength(1);
		});
	});
});
