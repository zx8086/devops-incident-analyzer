// packages/agent/src/eval/subagent-reports.ts
import type { DataSourceResult } from "@devops-agent/shared";

// SIO-1374: DataSourceResult has no plain-text report field -- only the typed per-datasource
// *Findings objects (kafkaFindings, elasticFindings, etc.) and opaque toolOutputs[].rawJson. The
// per-sub-agent judge grades the serialized *Findings object as that datasource's "report": it is
// the sub-agent's own synthesized conclusion, uninfluenced by the aggregator, and the types
// already exist -- see docs/superpowers/specs/2026-08-04-per-datasource-evidence-judging-design.md.
// Mirrors the keyed [name, value] lookup pattern in absence-judge.ts:133-143.
const FINDINGS_FIELD_BY_DATASOURCE: Record<string, keyof DataSourceResult> = {
	elastic: "elasticFindings",
	kafka: "kafkaFindings",
	couchbase: "couchbaseFindings",
	gitlab: "gitlabFindings",
	aws: "awsFindings",
	atlassian: "atlassianFindings",
};

// Builds one serialized "report" string per datasource id from that datasource's structured
// findings across every DataSourceResult entry (a datasource can appear multiple times when the
// sub-agent fanned out across deployments/estates, e.g. elastic across eu-b2b and us-cld). Entries
// with no matching *Findings field are omitted, not padded with an empty string, so the judge can
// distinguish "this datasource genuinely produced nothing" the same way it would for a human
// report with a blank section -- an absent key, not a misleadingly present empty one.
export function buildSubagentReports(results: DataSourceResult[]): { [dataSourceId: string]: string } {
	const byDatasource = new Map<string, string[]>();
	for (const result of results) {
		const field = FINDINGS_FIELD_BY_DATASOURCE[result.dataSourceId];
		if (!field) continue;
		const findings = result[field];
		if (findings == null) continue;
		const serialized = JSON.stringify(findings);
		const existing = byDatasource.get(result.dataSourceId) ?? [];
		existing.push(serialized);
		byDatasource.set(result.dataSourceId, existing);
	}
	const report: { [dataSourceId: string]: string } = {};
	for (const [dataSourceId, parts] of byDatasource) {
		report[dataSourceId] = parts.join("\n");
	}
	return report;
}
