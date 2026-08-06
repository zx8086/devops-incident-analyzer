// packages/agent/src/eval/subagent-reports.ts
import type { DataSourceResult } from "@devops-agent/shared";

// SIO-1374 originally serialized ONLY these typed *Findings objects, on the premise that
// DataSourceResult has no plain-text report field. That premise was wrong: `data` (z.unknown()
// in the schema, a string at runtime -- SubAgentOutcome.data, sub-agent.ts) IS the sub-agent's
// own narrative report. Typed findings are populated from the TYPED_FINDING_TOOLS subset only
// (SIO-1159), so evidence retrieved via generic tools never landed here and subagent_accuracy_*
// floored at serialization coverage, not sub-agent quality -- DEVOPS-1376's sub-agent had the
// ground-truth phrase 50x in its recorded tool results while the judge was handed `{}`
// (SIO-1405). The map is kept for the labeled typed-findings supplement below.
// Mirrors the keyed [name, value] lookup pattern in absence-judge.ts:133-143.
const FINDINGS_FIELD_BY_DATASOURCE: Record<string, keyof DataSourceResult> = {
	elastic: "elasticFindings",
	kafka: "kafkaFindings",
	couchbase: "couchbaseFindings",
	gitlab: "gitlabFindings",
	aws: "awsFindings",
	atlassian: "atlassianFindings",
	// orbitFindings is deliberately omitted: it rides the gitlab DataSourceResult but the
	// incident-replay dataset's referenceFindings.gitlab entries are source/MR-level facts only,
	// not Orbit cross-project blast-radius data, so including it would add noise the judge has
	// no ground truth to grade against.
};

// Builds one serialized "report" string per datasource id: the sub-agent's own narrative
// (`data`) first -- the primary evidence surface, uninfluenced by the aggregator -- then the
// typed findings as a labeled supplement (SIO-1405). A datasource can appear multiple times
// when the sub-agent fanned out across deployments/estates (e.g. elastic across eu-b2b and
// us-cld); every entry's parts are concatenated. Entries with neither narrative nor findings
// are omitted, not padded with an empty string, so the judge can distinguish "this datasource
// genuinely produced nothing" -- an absent key, not a misleadingly present empty one. An
// error-status result's narrative is still included: it is what the sub-agent produced, and
// the judge grades it against ground truth. Size is capped downstream per datasource by
// evaluators.ts's truncateForJudge, narrative-first so truncation eats the JSON tail.
export function buildSubagentReports(results: DataSourceResult[]): { [dataSourceId: string]: string } {
	const byDatasource = new Map<string, string[]>();
	for (const result of results) {
		const parts: string[] = [];
		// `data` is z.unknown() (null on the no-tools path) -- only a non-blank string counts.
		if (typeof result.data === "string" && result.data.trim().length > 0) {
			parts.push(result.data);
		}
		const field = FINDINGS_FIELD_BY_DATASOURCE[result.dataSourceId];
		const findings = field ? result[field] : undefined;
		if (findings != null) {
			parts.push(`Typed findings: ${JSON.stringify(findings)}`);
		}
		if (parts.length === 0) continue;
		const existing = byDatasource.get(result.dataSourceId) ?? [];
		existing.push(parts.join("\n"));
		byDatasource.set(result.dataSourceId, existing);
	}
	const report: { [dataSourceId: string]: string } = {};
	for (const [dataSourceId, parts] of byDatasource) {
		report[dataSourceId] = parts.join("\n");
	}
	return report;
}
