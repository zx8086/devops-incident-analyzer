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

	// --- kafka ------------------------------------------------------------------------------
	{
		inputs: {
			query: `Describe the ${LIVE_ANCHORS.kafka.cluster} Kafka cluster: how many brokers are there and what is the controller?`,
			uiSelectedDataSources: ["kafka"],
		},
		outputs: {
			expectedDatasources: ["kafka"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report broker count and controller/cluster identity for the named MSK cluster. A reachable cluster always answers this, so an inability to report it is a tool or connectivity failure rather than an absence of data.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "kafka",
						anyOf: ["kafka_get_cluster_info", "kafka_describe_cluster"],
						why: "cluster_info action group -- the cheapest proof the MSK path through the SigV4 proxy to AgentCore is alive end to end",
					},
				],
				forbiddenTools: ["kafka_create_topic", "kafka_delete_topic", "kafka_produce_message"],
				knownGoodAnchors: [{ toolName: "kafka_get_cluster_info", mustReturnRows: true }],
			},
		},
		metadata: { ticketKey: "SIO-1398-kafka-cluster-info", queryProvenance: "reconstructed", era: "2026-08" },
	},
	{
		inputs: {
			query: `List the consumer groups on ${LIVE_ANCHORS.kafka.cluster} and report which ones are showing meaningful lag.`,
			uiSelectedDataSources: ["kafka"],
		},
		outputs: {
			expectedDatasources: ["kafka"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name real consumer groups and characterise their lag. Zero lag across all groups is a legitimate healthy finding and should be reported as such, not as missing data.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "kafka",
						anyOf: ["kafka_list_consumer_groups", "kafka_describe_consumer_group", "kafka_get_consumer_group_lag"],
						why: "consumer_lag action group -- the primary incident path for kafka and the one whose arguments (group id, topic) the model most often gets wrong",
					},
				],
				forbiddenTools: ["kafka_reset_consumer_group_offsets", "kafka_delete_topic"],
				knownGoodAnchors: [{ toolName: "kafka_list_consumer_groups", mustReturnRows: true }],
			},
		},
		metadata: { ticketKey: "SIO-1398-kafka-consumer-lag", queryProvenance: "reconstructed", era: "2026-08" },
	},

	// --- couchbase --------------------------------------------------------------------------
	{
		inputs: {
			query: `What is the current health of the Couchbase Capella cluster hosting the ${LIVE_ANCHORS.couchbase.bucket} bucket? Report node status and any service alerts.`,
			uiSelectedDataSources: ["couchbase"],
		},
		outputs: {
			expectedDatasources: ["couchbase"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report cluster/node health for the Capella cluster. These are current-state tools with no historical window, so a healthy cluster returning nominal values is the expected good outcome.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "couchbase",
						anyOf: [
							"capella_get_cluster_health",
							"capella_get_system_vitals",
							"capella_get_system_nodes",
							"capella_ping",
						],
						why: "system_vitals action group -- current-state health tools; the only way to answer, and they always return data on a reachable cluster",
					},
				],
				forbiddenTools: ["capella_delete_document_by_id", "capella_upsert_document_by_id"],
				knownGoodAnchors: [{ toolName: "capella_get_cluster_health", mustReturnRows: true }],
			},
		},
		metadata: { ticketKey: "SIO-1398-couchbase-cluster-health", queryProvenance: "reconstructed", era: "2026-08" },
	},

	// --- gitlab -----------------------------------------------------------------------------
	{
		inputs: {
			query: `List the most recent merge requests in GitLab project ${LIVE_ANCHORS.gitlab.projectId} and summarise what changed.`,
			uiSelectedDataSources: ["gitlab"],
		},
		outputs: {
			expectedDatasources: ["gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name real merge requests from the project with titles and state. GitLab data is durable (not retention-limited), so an active project always has MRs to report.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "gitlab",
						anyOf: ["gitlab_list_merge_requests", "gitlab_get_merge_request", "gitlab_list_commits"],
						why: "merge_requests action group -- gitlab_list_merge_requests is the flagship code-change correlation input and was historically unreachable through the action map (SIO-1178), so it is worth pinning explicitly",
					},
				],
				forbiddenTools: ["gitlab_create_merge_request", "gitlab_create_issue", "gitlab_manage_pipeline"],
				knownGoodAnchors: [{ toolName: "gitlab_list_merge_requests", mustReturnRows: true }],
			},
		},
		metadata: { ticketKey: "SIO-1398-gitlab-merge-requests", queryProvenance: "reconstructed", era: "2026-08" },
	},

	// --- atlassian --------------------------------------------------------------------------
	{
		inputs: {
			query: `Search Jira on the ${LIVE_ANCHORS.atlassian.site} site for recent incident tickets and summarise the most recent few.`,
			uiSelectedDataSources: ["atlassian"],
		},
		outputs: {
			expectedDatasources: ["atlassian"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name real Jira issues with keys and summaries, or state clearly that the search returned nothing. Atlassian data is durable, so a populated site should yield tickets.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "atlassian",
						anyOf: ["atlassian_searchJiraIssuesUsingJql", "atlassian_search", "atlassian_fetch"],
						why: "jira_query action group -- exercises the Rovo OAuth proxy path end to end, and JQL is an argument-heavy surface where malformed queries surface as bad-query",
					},
				],
				forbiddenTools: ["atlassian_createJiraIssue", "atlassian_editJiraIssue", "atlassian_transitionJiraIssue"],
			},
		},
		metadata: { ticketKey: "SIO-1398-atlassian-jira-search", queryProvenance: "reconstructed", era: "2026-08" },
	},

	// --- aws --------------------------------------------------------------------------------
	{
		inputs: {
			query: `List the ECS clusters and their running services in the ${LIVE_ANCHORS.aws.estates[0]} AWS estate.`,
			uiSelectedDataSources: ["aws"],
			uiSelectedAwsEstates: [LIVE_ANCHORS.aws.estates[0]],
		},
		outputs: {
			expectedDatasources: ["aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name real ECS clusters and services in the named estate. A production estate always has ECS state, so an empty answer points at a cross-account AssumeRole or argument problem rather than at reality.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "aws",
						anyOf: ["aws_ecs_list_clusters", "aws_ecs_list_services", "aws_ecs_describe_services"],
						why: "ecs_state action group -- also the tightest check that the per-estate AssumeRole path works, since every one of these fails closed without it",
					},
				],
				knownGoodAnchors: [{ toolName: "aws_ecs_list_clusters", mustReturnRows: true }],
			},
		},
		metadata: { ticketKey: "SIO-1398-aws-ecs-state", queryProvenance: "reconstructed", era: "2026-08" },
	},
	{
		inputs: {
			query: `Which CloudWatch alarms are currently in ALARM state in the ${LIVE_ANCHORS.aws.estates[1]} AWS estate?`,
			uiSelectedDataSources: ["aws"],
			uiSelectedAwsEstates: [LIVE_ANCHORS.aws.estates[1]],
		},
		outputs: {
			expectedDatasources: ["aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report alarm state for the named estate. No alarms firing is a legitimate healthy result and must be reported as such rather than as a gap; the tool call itself still has to happen.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "aws",
						anyOf: ["aws_cloudwatch_describe_alarms"],
						why: "cloudwatch_alarms action group -- a single-tool group, so it isolates tool selection from argument correctness: if it does not fire, the action map or binder is at fault, not the query",
					},
				],
				// No anchor: an estate with zero firing alarms is healthy, and flagging that as
				// suspicious emptiness would make a good outcome look like a defect.
			},
		},
		metadata: { ticketKey: "SIO-1398-aws-cloudwatch-alarms", queryProvenance: "reconstructed", era: "2026-08" },
	},

	// --- konnect ----------------------------------------------------------------------------
	// Konnect is intentionally disabled in this dev environment (precheck.ts marks it
	// required:false and the agent soft-skips it). The example is carried so coverage is
	// complete the moment it is enabled; `--datasource konnect` will report zero calls until
	// then, which is the correct, visible signal rather than silent absence.
	{
		inputs: {
			query: "List the services configured in Kong Konnect and report their upstream targets.",
			uiSelectedDataSources: ["konnect"],
		},
		outputs: {
			expectedDatasources: ["konnect"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name real Konnect services and their upstreams. If the Konnect datasource is disabled in this environment, the response should say so plainly rather than inventing gateway state.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "konnect",
						anyOf: ["konnect_list_services", "konnect_get_service", "konnect_list_routes"],
						why: "service_config action group -- the basic read path; only meaningful once konnect is enabled",
					},
				],
				forbiddenTools: ["konnect_create_service", "konnect_delete_service", "konnect_update_service"],
			},
		},
		metadata: { ticketKey: "SIO-1398-konnect-service-config", queryProvenance: "reconstructed", era: "2026-08" },
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
