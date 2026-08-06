// packages/agent/src/eval/mcp-tool-dataset.ts
//
// SIO-1398: the mcp-tool-eval dataset -- per-datasource examples that audit TOOL CORRECTNESS
// (are the right calls made with valid arguments, and does the right data come back), as
// opposed to incident-replay-dataset.ts which is a model A/B harness grading report quality.
// Deliberately a SEPARATE dataset: this one should run on every MCP server change, independent
// of any model comparison, and its 7-datasource coverage is systematic rather than "whatever
// tools those 32 incidents happened to touch".
//
// Every example pins ONE datasource via uiSelectedDataSources, so a single sub-agent runs and
// any failure is unambiguously attributable to that server. entity-extractor.ts:234 makes UI
// selection the effective target and RunAgentInputsSchema already accepts the pinning fields,
// so this needs no production change.
//
// Queries are written to force a specific action group from that datasource's
// agents/incident-analyzer/tools/<ds>-*.yaml action_tool_map, anchored on an entity that
// returns rows TODAY. An example that returns zero calls means the anchor or the query is
// wrong -- not that the tools are healthy.

import type { EvalExample } from "./dataset.ts";

// SIO-1398: every live anchor in ONE place, so a drifting entity is a one-line fix rather than
// a dataset-wide edit. Verified 2026-08-06 against the LIVE .env (NOT .env.example, which
// drifts) and prior audits -- see the per-field evidence notes.
export const LIVE_ANCHORS = {
	// All 32 incident-replay examples pin this deployment; styles-v3 appears in 21 of them.
	elastic: { deployment: "eu-b2b", service: "pvh-services-styles-v3" },
	// Documented known-good topic on c72-shared-services-msk
	// (experiments/HANDOFF-2026-05-10-sio-699-700.md:151). Note `example-topic` also exists but
	// hit a per-topic IAM gap, so it is deliberately NOT the anchor.
	kafka: { topic: "T_PRIVATE_SAP_CAR_PRICES", cluster: "c72-shared-services-msk" },
	// COUCHBASE_BUCKET in the live .env (PVH Prd cluster).
	couchbase: { bucket: "default" },
	// GITLAB_DEFAULT_PROJECT_ID in the live .env.
	gitlab: { projectId: "57520959" },
	// ATLASSIAN_SITE_NAME in the live .env.
	atlassian: { site: "pvhcorp" },
	// 23/32 incident-replay examples use exactly this estate pair
	// (docs/runbooks/aws-estate-onboarding.md:15,21).
	aws: { estates: ["eu-oit-prd", "eu-shared-services-prd"] },
} as const;

// Retention shapes which anchors can return data, and an empty result from an out-of-window
// query is an ENVIRONMENT state, not a tool defect (the tool-audit runbook's rubric). Queries
// below stay inside these windows deliberately.
//   elastic       ~30d hot
//   aws cloudwatch ~60d, expiring
//   couchbase/konnect current-state-only tools (no historical window at all)
//   gitlab/atlassian durable (MRs, deploys, tickets)

// The empty-anchor check runs inside the run function (only it can see rawJson), which receives
// example INPUTS only. Rather than hand-copying anchor names into both halves of every example
// -- where they would eventually disagree -- this derives inputs.knownGoodAnchorTools from the
// authoritative outputs.expectedToolUse.knownGoodAnchors. One source, mechanically mirrored.
function withAnchorInputs(example: EvalExample): EvalExample {
	const anchors = example.outputs.expectedToolUse?.knownGoodAnchors ?? [];
	if (anchors.length === 0) return example;
	return {
		...example,
		inputs: { ...example.inputs, knownGoodAnchorTools: anchors.map((a) => a.toolName) },
	};
}

const EXAMPLES: EvalExample[] = [
	// --- elastic ----------------------------------------------------------------------------
	{
		inputs: {
			query: `What is the current cluster health of the ${LIVE_ANCHORS.elastic.deployment} Elasticsearch deployment? Report status, node count, and any unassigned shards.`,
			uiSelectedDataSources: ["elastic"],
			uiSelectedElasticDeployments: [LIVE_ANCHORS.elastic.deployment],
		},
		outputs: {
			expectedDatasources: ["elastic"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report the cluster's health status (green/yellow/red), node count, and shard state for the named deployment. Cluster health is always available, so an inability to report it is a tool failure, not an absence of data.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "elastic",
						anyOf: ["elasticsearch_get_cluster_health", "elasticsearch_get_cluster_stats", "elasticsearch_diagnostics"],
						why: "cluster_health action group -- the only tools that return live cluster status; a health question that never calls one of these did not actually look",
					},
				],
				// A read-only health question must not reach for write/destructive tools.
				forbiddenTools: [
					"elasticsearch_delete_index",
					"elasticsearch_create_index",
					"elasticsearch_update_index_settings",
				],
				knownGoodAnchors: [{ toolName: "elasticsearch_get_cluster_health", mustReturnRows: true }],
			},
		},
		metadata: {
			ticketKey: "SIO-1398-elastic-cluster-health",
			queryProvenance: "reconstructed",
			era: "2026-08",
		},
	},
	{
		inputs: {
			query: `List the indices on the ${LIVE_ANCHORS.elastic.deployment} Elasticsearch deployment and summarise which ones hold the most documents.`,
			uiSelectedDataSources: ["elastic"],
			uiSelectedElasticDeployments: [LIVE_ANCHORS.elastic.deployment],
		},
		outputs: {
			expectedDatasources: ["elastic"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should list real index names from the deployment and give a sense of relative size or document counts. A populated production deployment always has indices, so an empty answer indicates a tool or argument problem.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "elastic",
						anyOf: ["elasticsearch_list_indices", "elasticsearch_indices_summary", "elasticsearch_get_index_info"],
						why: "index_management action group -- listing indices is the only way to answer; this also exercises the largest action group's tool selection",
					},
				],
				forbiddenTools: ["elasticsearch_delete_index", "elasticsearch_create_index"],
				knownGoodAnchors: [{ toolName: "elasticsearch_list_indices", mustReturnRows: true }],
			},
		},
		metadata: {
			ticketKey: "SIO-1398-elastic-index-inventory",
			queryProvenance: "reconstructed",
			era: "2026-08",
		},
	},
	{
		inputs: {
			query: `Search the last 24 hours of logs on ${LIVE_ANCHORS.elastic.deployment} for the ${LIVE_ANCHORS.elastic.service} service and report the error volume and the most common error types.`,
			uiSelectedDataSources: ["elastic"],
			uiSelectedElasticDeployments: [LIVE_ANCHORS.elastic.deployment],
		},
		outputs: {
			expectedDatasources: ["elastic"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report on log volume for the named service over the stated window, naming concrete error types or stating clearly that the window was clean. A zero-hit result must be reported as an observation with the window and filters used, not as a tool failure.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "elastic",
						anyOf: [
							"elasticsearch_search",
							"elasticsearch_multi_search",
							"elasticsearch_esql_query",
							"elasticsearch_count_documents",
						],
						why: "search action group -- the core query path and the most argument-heavy surface (time window, service filter, index pattern), so it is where malformed arguments show up first",
					},
				],
				// The 24h window sits inside elastic's ~30d hot retention, so the search itself
				// must return something even if the service was healthy. No mustReturnRows anchor
				// here: a genuinely clean window is a legitimate zero-hit result, unlike the
				// cluster-health and list-indices anchors above which are always populated.
			},
		},
		metadata: {
			ticketKey: "SIO-1398-elastic-service-errors",
			queryProvenance: "reconstructed",
			era: "2026-08",
		},
	},
];

export const MCP_TOOL_DATASET: EvalExample[] = EXAMPLES.map(withAnchorInputs);

// Examples for one datasource, for `--datasource <ds>`. Matches on the pinned
// uiSelectedDataSources rather than expectedDatasources: the pin is what actually constrains
// the fan-out, so filtering on anything else could select an example that runs a different
// sub-agent than the flag names.
export function examplesForDatasource(datasource: string): EvalExample[] {
	return MCP_TOOL_DATASET.filter((example) => example.inputs.uiSelectedDataSources?.includes(datasource));
}

// Every datasource this dataset currently covers, in a stable order.
export function coveredDatasources(): string[] {
	const seen = new Set<string>();
	for (const example of MCP_TOOL_DATASET) {
		for (const ds of example.inputs.uiSelectedDataSources ?? []) seen.add(ds);
	}
	return [...seen].sort();
}
