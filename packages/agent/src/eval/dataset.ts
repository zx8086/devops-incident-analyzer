// packages/agent/src/eval/dataset.ts

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
				"Should identify the lag root cause (consumer crash / slow processing / DLQ growth), correlate with Elasticsearch error logs from notifications-service in eu-b2b deployment, and check if downstream Couchbase writes are failing. Mitigation must include scaling consumers OR resetting offsets WITH explicit human-approval flag.",
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
				"Should query Konnect for the route's plugin chain and recent service config changes, search Elasticsearch for upstream service errors aligned with 14:00 UTC, and check GitLab for recent deploys to the upstream service. Should distinguish plugin-misconfiguration from upstream-failure.",
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
				"Should distinguish slow_queries (latency outliers above threshold) from fatal_requests (true timeouts/OOM). Should check Elasticsearch for the application's database client errors. Mitigation should reference index_analysis if scan-heavy queries are implicated.",
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
				"Should pick the billing action (NOT cloud_deployment alone) and break down cost by deployment via the v2 billing API. Should NOT propose mitigation -- this is a cost-reporting query, not an incident.",
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
				"Should call atlassian.runbook_lookup AND incident_correlation. GitLab for related deploys around the 03:00 UTC window. Response is informational (post-mortem), no remediation steps.",
		},
	},
];
