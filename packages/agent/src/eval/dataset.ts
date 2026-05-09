// packages/agent/src/eval/dataset.ts
// SIO-692: rubrics grade the final response string only. The judge in
// evaluators.ts cannot see tool-call trajectory -- it sees run.outputs.output.response.
// Phrase rubrics as response-content checks ("response should mention X"), not
// trajectory checks ("should call tool.foo" / "should query Y for Z").

export interface EvalExample {
	inputs: { query: string };
	outputs: {
		expectedDatasources: string[];
		minConfidence: number;
		qualityRubric: string;
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
