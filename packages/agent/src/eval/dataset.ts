// packages/agent/src/eval/dataset.ts
// SIO-692: rubrics grade the final response string only. The judge in
// evaluators.ts cannot see tool-call trajectory -- it sees run.outputs.output.response.
// Phrase rubrics as response-content checks ("response should mention X"), not
// trajectory checks ("should call tool.foo" / "should query Y for Z").

// SIO-1398: TOOL-level ground truth, consumed by expectedToolsFired and toolResponseHealth.
//
// Deliberately expresses NO argument-level expectations. Args are not in graph state, and
// curated arg values rot fastest against live systems whose index names and time windows drift;
// argument CORRECTNESS is graded drift-free by tool_arg_validity, which reads the server's own
// validation verdict rather than a curator's guess.
export interface ExpectedToolUse {
	// Conjunctive across groups, DISJUNCTIVE within one: every group must be satisfied, and any
	// single member satisfies its group. The disjunction is the main anti-brittleness property --
	// ground truth is "lag was retrieved somehow", not one literal tool name, because names change
	// on MCP server upgrades and the 25-tool binder (MAX_TOOLS_PER_AGENT) makes the bound set
	// dynamic per run.
	requiredToolGroups: {
		dataSource: string;
		anyOf: string[];
		// Required: forces the curator to justify the group. When it later goes red, a reader can
		// tell "genuinely required" from "transcribed whatever ran that day".
		why: string;
	}[];
	// Tools that must NOT be called (e.g. write/destructive tools on a read-only question).
	forbiddenTools?: string[];
	// Tools whose anchor is known-good and populated, so an empty result is a FINDING, not a
	// result (the tool-audit runbook's "suspicious emptiness" rule). Omit for tools whose
	// emptiness is legitimately informative (a clean error window).
	knownGoodAnchors?: { toolName: string; mustReturnRows: true }[];
}

export interface EvalExample {
	inputs: {
		query: string;
		// SIO-1371: real incident replays carry the exact UI datasource/deployment/estate
		// selections the user had active, so the eval exercises the same fixed-target path
		// production runs use (entityExtractor takes uiSelected as effectiveTargets directly,
		// see entity-extractor.ts:203/234) rather than letting free entity extraction guess.
		// Optional: the synthetic dataset.ts examples omit this and rely on free extraction.
		uiSelectedDataSources?: string[];
		uiSelectedElasticDeployments?: string[];
		uiSelectedAwsEstates?: string[];
		// SIO-1398: tool names from outputs.expectedToolUse.knownGoodAnchors, mirrored onto the
		// INPUTS because only inputs reach the run function -- and the empty-anchor check needs
		// rawJson, which exists nowhere else. Derived by withAnchorInputs(), never hand-written,
		// so the two can never disagree.
		knownGoodAnchorTools?: string[];
	};
	outputs: {
		expectedDatasources: string[];
		minConfidence: number;
		qualityRubric: string;
		// SIO-1372: the real, human-curated ticket's own Executive Summary / root-cause text, used
		// by responseQualityJudge as a holistic reference answer instead of a per-clause checklist
		// (the earlier binary meets_rubric grading flattened real quality gradients between two
		// responses to a single 0/1 -- see evaluators.ts). Optional: only incident-replay-dataset.ts
		// entries (real tickets) have a real report to compare against; the synthetic dataset.ts
		// examples have no source ticket and omit this.
		referenceReport?: string;
		// SIO-1374: per-datasource ground truth, backfilled from each real ticket's own "Findings
		// by Datasource" section. Keys are datasource ids (elastic, kafka, couchbase, gitlab, aws,
		// atlassian) matching expectedDatasources entries. Used by the per-datasource evidence
		// verdicts (evaluators.ts datasourceVerdicts) and the per-sub-agent judge, which need
		// datasource-level ground truth that referenceReport's Executive-Summary-only text does not
		// provide. Optional: only incident-replay-dataset.ts entries have per-datasource source
		// material; the synthetic dataset.ts examples omit this.
		referenceFindings?: { [datasource: string]: string };
		// SIO-1398: TOOL-level ground truth, used by expectedToolsFired and toolResponseHealth.
		// Optional and only populated by mcp-tool-dataset.ts -- the evaluators emit no feedback
		// for an example that omits it, so a partial rollout is well-defined.
		//
		// Deliberately expresses NO argument-level expectations. Args are not in graph state, and
		// curated arg values rot fastest against live systems whose index names and time windows
		// drift; argument CORRECTNESS is graded drift-free by tool_arg_validity, which reads the
		// server's own validation verdict rather than a curator's guess.
		expectedToolUse?: ExpectedToolUse;
	};
	// SIO-1378: per-example provenance, uploaded as LangSmith example metadata by
	// build-incident-replay-dataset.ts so runs are filterable by ticket, era, and query
	// fidelity. Optional: the synthetic examples above have no source ticket.
	metadata?: {
		ticketKey: string;
		// ISO date of the incident itself, only when the ticket's own text records one.
		incidentDate?: string;
		// verbatim = recovered from Agent Memory; verbatim-adjacent = full ticket content in
		// hand but no memory block (DEVOPS-1391); reconstructed = rebuilt from the ticket's
		// quoted error strings, NOT what the user actually typed.
		queryProvenance: "verbatim" | "verbatim-adjacent" | "reconstructed";
		// YYYY-MM the ground truth was curated -- reference reports/findings are frozen at this
		// era while live replays investigate current systems (the judge's recurrence-window
		// exemption compensates; see evaluators.ts).
		era: string;
		// Reserved for future fresh-incident entries whose historical window is still inside
		// datasource retention; nothing consumes this yet (time anchoring is deliberately
		// deferred -- see eval README).
		incidentWindow?: { from: string; to: string };
	};
}

export const DATASET: EvalExample[] = [
	{
		inputs: {
			query:
				"Consumer group payments-ingest on c72-shared-services-msk has been stuck at 50k lag for 30 minutes; users are seeing stale order status. Diagnose.",
		},
		outputs: {
			expectedDatasources: ["kafka", "elastic", "couchbase"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name a probable lag root cause (consumer crash, slow processing, DLQ growth, or stuck listener). Response should reference Elasticsearch findings for the notifications-service application, and discuss whether downstream Couchbase writes are at risk or healthy. Mitigation should mention scaling consumers OR resetting offsets, gated on human approval.",
		},
	},
	{
		inputs: {
			query:
				"Kong /v1/users route is returning 5xx for 15% of requests since 14:00 UTC. Which plugin chain or upstream change broke it?",
		},
		outputs: {
			expectedDatasources: ["konnect", "elastic", "gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name Kong/Konnect plugin chain or upstream service changes as candidate causes. Response should cite Elasticsearch upstream-service errors observed near 14:00 UTC, and reference recent GitLab deploys (or note their absence). Response should distinguish plugin-misconfiguration from upstream-failure as separate hypotheses.",
		},
	},
	{
		inputs: {
			query: "Couchbase queries on bucket orders-prod are timing out for the last hour. Slow queries or fatal errors?",
		},
		outputs: {
			expectedDatasources: ["couchbase", "elastic"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should distinguish slow queries (latency outliers) from fatal request errors (true timeouts / OOM) as separate categories. Response should cite Elasticsearch findings for the application's database client errors. If scan-heavy queries are implicated, response should recommend index analysis.",
		},
	},
	{
		inputs: {
			query: "AWS bill for our Elastic Cloud spiked 40% this month. Which deployments and which usage class?",
		},
		outputs: {
			expectedDatasources: ["elastic"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report cost broken down by deployment. Response should treat the question as cost reporting, NOT as an incident. Response should NOT propose mitigation or remediation steps.",
		},
	},
	{
		inputs: {
			query:
				"We had a P1 yesterday at 03:00 UTC affecting checkout. Show me the runbook we used and any related Jira tickets.",
		},
		outputs: {
			expectedDatasources: ["atlassian", "gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report runbook lookup results from Atlassian (whether a runbook was found or not), and any related Jira incident tickets. Response should reference GitLab deploys around the 03:00 UTC window (or explicitly note none were found). Response should be informational / post-mortem in tone -- no remediation or mitigation steps.",
		},
	},
];
