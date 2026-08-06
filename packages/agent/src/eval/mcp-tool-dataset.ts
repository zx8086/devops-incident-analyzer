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
// Every value below was PROBED against the live MCP server on 2026-08-06 and confirmed to
// return rows -- not inferred from config or from what other datasets happen to use. An
// unverified anchor produces a false empty-anchor finding, which is worse than no coverage.
export const LIVE_ANCHORS = {
	// All 32 incident-replay examples pin this deployment; styles-v3 appears in 21 of them.
	// Verified: elasticsearch_search on logs-apm.error-* returns 2,177 hits for this service.
	elastic: { deployment: "eu-b2b", service: "pvh-services-styles-v3" },
	kafka: {
		// Documented known-good topic (experiments/HANDOFF-2026-05-10-sio-699-700.md:151).
		// Verified: kafka_describe_topic returns partitions. `example-topic` also exists but hit
		// a per-topic IAM gap, so it is deliberately NOT the anchor.
		topic: "T_PRIVATE_SAP_CAR_PRICES",
		cluster: "c72-shared-services-msk",
		// Verified STABLE group from a live kafka_list_consumer_groups; kafka_get_consumer_group_lag
		// against it returns a real totalLag. Needed because that tool requires `groupId` -- without
		// a real value the model must first discover one, which it does not reliably do.
		consumerGroup: "connect-C_SINK_COUCHBASE_PRICES_DOCUMENTS",
	},
	couchbase: {
		// COUCHBASE_BUCKET in the live .env (PVH Prd cluster).
		bucket: "default",
		// Verified via capella_get_scopes_and_collections. Needed for capella_get_document_by_id
		// and capella_run_sql_plus_plus_query, both of which require scope_name.
		scope: "customer",
		collection: "customers",
	},
	// SIO-1401 RESOLVED 2026-08-06. Root cause was config, not code: the PAT was a PROJECT access
	// token scoped to 82850717 only. A project token can never span projects, and GitLab returns
	// 404 -- not 403 -- for a project you cannot see, which is why it presented as a missing
	// project rather than an auth-scope problem.
	//
	// Fixed by a group-level token (group_14146787_bot_*). Verified live: list_merge_requests,
	// list_commits, get_repository_tree and search all return real data for this project.
	//
	// The former GITLAB_DEFAULT_PROJECT_ID env var is GONE (removed in this change): it was
	// parsed into config in three places and read by zero tool handlers, since every gitlab tool
	// takes an explicit project_id. Its stale value pointed at a project that does not exist,
	// which sent this session chasing a 404 no code path ever consulted. Project ids belong in
	// the example that needs them -- here.
	gitlab: {
		projectId: "43242609",
		path: "pvhcorp/b2b/shared-services/pvh.services.styles",
		searchableNamespace: "pvhcorp",
	},
	// ATLASSIAN_SITE_NAME in the live .env.
	atlassian: { site: "pvhcorp" },
	aws: {
		// 23/32 incident-replay examples use exactly this estate pair
		// (docs/runbooks/aws-estate-onboarding.md:15,21).
		estates: ["eu-oit-prd", "eu-shared-services-prd"],
		// Verified via aws_ecs_list_clusters on eu-oit-prd. Most AWS tools require `estate` (which
		// uiSelectedAwsEstates already supplies); the ECS detail tools additionally require
		// `cluster`, so a real cluster name is what unlocks them.
		ecsCluster: "orders-prd",
	},
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

	// --- coverage expansion (SIO-1398) -------------------------------------------------------
	// The examples above were hand-picked; these target the highest-value gaps reported by
	// coverage-targets.ts, prioritising tools named by MORE THAN ONE deterministic source
	// (runbook + typed-finding + resolution), since those have a declared functional
	// consequence if never called -- a findings card or correlation rule silently not firing.
	//
	// knownGoodAnchors are deliberately OMITTED throughout this block: none of these anchors
	// has been verified to return rows in this environment (a populated DLQ, an Orbit-indexed
	// project, Kafka Connect enabled). An unverified anchor produces a false empty-anchor
	// finding, which is worse than no coverage -- add them once each is confirmed live.

	{
		inputs: {
			query: `Which topics on ${LIVE_ANCHORS.kafka.cluster} are dead-letter queues, and are any accumulating messages? Separately, report the partition layout and current offsets of topic ${LIVE_ANCHORS.kafka.topic}.`,
			uiSelectedDataSources: ["kafka"],
		},
		outputs: {
			expectedDatasources: ["kafka"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report which DLQ topics exist (or state clearly that none do) AND separately describe the named topic's partitions/offsets. Both halves must be answered -- a response covering only one is incomplete. An empty DLQ set is a healthy finding, not a gap.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "kafka",
						anyOf: ["kafka_list_dlq_topics", "kafka_list_topics"],
						why: "dlq_messages action group -- kafka_list_dlq_topics feeds the kafka typed extractor (TYPED_FINDING_TOOLS) and the DLQ correlation path",
					},
					{
						dataSource: "kafka",
						anyOf: ["kafka_describe_topic", "kafka_get_topic_offsets"],
						why: "describe_topic action group, runbook-cited (kafka-consumer-lag). The previous phrasing of this example buried the topic ask in a trailing clause and the model answered only the DLQ half (0.5 on expected_tools_fired, run 35ee7eca) -- the two asks are now explicitly separated",
					},
				],
				forbiddenTools: ["kafka_delete_topic", "kafka_produce_message", "kafka_reset_consumer_group_offsets"],
				// Both verified zero-arg-OK live; the cluster genuinely has topics.
				knownGoodAnchors: [{ toolName: "kafka_list_topics", mustReturnRows: true }],
			},
		},
		metadata: { ticketKey: "SIO-1398-kafka-dlq-and-topics", queryProvenance: "reconstructed", era: "2026-08" },
	},
	{
		inputs: {
			query: `Check the health of the Kafka Connect and ksqlDB estate on ${LIVE_ANCHORS.kafka.cluster}: which connectors are registered and what state are they in, and what ksql queries are running? Also report the lag on consumer group ${LIVE_ANCHORS.kafka.consumerGroup}.`,
			uiSelectedDataSources: ["kafka"],
		},
		outputs: {
			expectedDatasources: ["kafka"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name registered connectors with their state, report running ksql queries, and give the named consumer group's lag. If Connect or ksqlDB is not enabled the response should say so plainly rather than inventing state.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "kafka",
						anyOf: ["connect_list_connectors", "connect_get_connector_status"],
						why: "connect_status action group -- both are in TYPED_FINDING_TOOLS and feed the kafka extractor's connector findings; connect_list_connectors verified zero-arg-OK live, contradicting the earlier assumption that Connect was unavailable",
					},
					{
						dataSource: "kafka",
						anyOf: ["ksql_list_queries", "ksql_get_server_info"],
						why: "ksql action group -- ksql_list_queries is in TYPED_FINDING_TOOLS; both verified zero-arg-OK",
					},
					{
						dataSource: "kafka",
						anyOf: ["kafka_get_consumer_group_lag", "kafka_describe_consumer_group"],
						why: "consumer_lag with a REAL groupId supplied in the prompt -- these tools require groupId, so without a verified value the model must discover one first, which it does not do reliably",
					},
				],
				forbiddenTools: ["kafka_reset_consumer_group_offsets", "kafka_delete_topic"],
				knownGoodAnchors: [{ toolName: "connect_list_connectors", mustReturnRows: true }],
			},
		},
		metadata: { ticketKey: "SIO-1398-kafka-connect-ksql", queryProvenance: "reconstructed", era: "2026-08" },
	},
	// SIO-1401 is resolved (group-level token + correct project id), so the REST-path tools are
	// reachable again and anchors are restored. Verified live via :9184 before re-enabling:
	// list_merge_requests, list_commits and get_repository_tree all return real data for 43242609.
	{
		inputs: {
			query: `Trace recent code changes in GitLab project ${LIVE_ANCHORS.gitlab.projectId} (${LIVE_ANCHORS.gitlab.path}): which merge requests and commits landed most recently, and what does the repository tree look like at the root?`,
			uiSelectedDataSources: ["gitlab"],
		},
		outputs: {
			expectedDatasources: ["gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name real merge requests and commits with titles, and describe the repository layout. This is an active production service, so an empty answer indicates an access or argument problem rather than an inactive project.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "gitlab",
						anyOf: ["gitlab_list_merge_requests", "gitlab_get_merge_request"],
						why: "gitlab_list_merge_requests is the flagship code-change correlation input (sole input to extractGitLabFindings, SIO-1178) and is force-included via RESOLUTION -- it was 404ing under the old project-scoped token",
					},
					{
						dataSource: "gitlab",
						anyOf: ["gitlab_list_commits", "gitlab_get_commit_diff"],
						why: "code-change-correlation runbook's commit path; both require project_id and were unreachable before SIO-1401",
					},
					{
						dataSource: "gitlab",
						anyOf: ["gitlab_get_repository_tree", "gitlab_get_file_content"],
						why: "repository structure -- get_repository_tree needs only project_id and was 404ing; it is the cheapest proof the REST path is healthy",
					},
				],
				forbiddenTools: ["gitlab_create_merge_request", "gitlab_create_issue", "gitlab_manage_pipeline"],
				// NO anchor on gitlab_list_merge_requests, despite the project genuinely having MRs
				// (iid 383/382 verified live). The first post-SIO-1401 run flagged empty-anchor
				// twice, and the cause was the EVAL, not the tool: the model reasonably added
				// `updated_after` to answer "most recently landed", and this project's MRs had not
				// been updated inside that window -- `{project_id}` returns rows while
				// `{project_id, updated_after}` returns []. An anchor cannot survive the model
				// adding a legitimate filter, so asserting must-return-rows on a filterable list
				// tool manufactures false findings. Anchors belong on tools whose result does not
				// depend on a model-chosen window (cluster health, index inventory).
			},
		},
		metadata: { ticketKey: "SIO-1398-gitlab-change-correlation", queryProvenance: "reconstructed", era: "2026-08" },
	},
	{
		inputs: {
			query: `Search GitLab across the ${LIVE_ANCHORS.gitlab.searchableNamespace} namespace for code related to "styles", then report what the code graph knows: recent deploys, failing pipelines, and any known vulnerabilities.`,
			uiSelectedDataSources: ["gitlab"],
		},
		outputs: {
			expectedDatasources: ["gitlab"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report search results from the namespace and whatever the graph-backed tools return, stating plainly when a project is not indexed. A not-indexed result should be reported as an indexing limitation, NOT as an absence of code changes.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "gitlab",
						anyOf: ["gitlab_search", "gitlab_semantic_code_search"],
						why: "search action group -- gitlab_search is force-included via RESOLUTION and goes through the OAuth proxy rather than the REST client, so it exercises the OTHER gitlab auth path (the split that made SIO-1401 look like a code bug)",
					},
					{
						dataSource: "gitlab",
						anyOf: ["gitlab_recent_deploys", "gitlab_pipeline_failures", "gitlab_recent_vulnerabilities"],
						why: "graph_analysis -- all three are in TYPED_FINDING_TOOLS and feed the orbit extractor; they take `since` or nothing, so none depends on a project id",
					},
				],
				forbiddenTools: ["gitlab_create_merge_request", "gitlab_create_issue", "gitlab_manage_pipeline"],
				// No anchor on the graph tools: Orbit indexing is separate from token scope, and
				// `no-index` remains a legitimate environment state rather than a defect.
			},
		},
		metadata: { ticketKey: "SIO-1398-gitlab-search-and-graph", queryProvenance: "reconstructed", era: "2026-08" },
	},
	// Couchbase carries the widest zero-arg surface of any datasource: 16 of its 19 coverage
	// targets take NO required params (probed live 2026-08-06), so a single broad question can
	// legitimately sweep most of them. Split across two examples -- query performance and index
	// health -- rather than one, so a miss points at a specific area.
	{
		inputs: {
			query: `Give me a full query-performance profile of the Couchbase cluster behind the ${LIVE_ANCHORS.couchbase.bucket} bucket: the longest-running, most expensive and most frequent queries, any fatal or failed requests, and which prepared statements are in play.`,
			uiSelectedDataSources: ["couchbase"],
		},
		outputs: {
			expectedDatasources: ["couchbase"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should cover query latency outliers, cost, frequency and any fatal requests, naming concrete statements or stating plainly that a category was empty. These are current-state tools with no time window, so an idle cluster returning few queries is a healthy finding.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "couchbase",
						anyOf: ["capella_get_longest_running_queries", "capella_get_most_expensive_queries"],
						why: "slow_queries action group -- capella_get_longest_running_queries is couchbase's ONLY entry in TYPED_FINDING_TOOLS, so if it never fires the couchbase findings card cannot populate",
					},
					{
						dataSource: "couchbase",
						anyOf: ["capella_get_fatal_requests", "capella_get_completed_requests"],
						why: "fatal_requests action group -- the failure-side counterpart to slow queries; both are zero-arg and runbook-cited (database-slow-queries)",
					},
					{
						dataSource: "couchbase",
						anyOf: ["capella_get_prepared_statements", "capella_get_detailed_prepared_statements"],
						why: "runbook-cited (database-slow-queries) and zero-arg; prepared-statement reuse is a distinct diagnosis from raw latency",
					},
				],
				forbiddenTools: ["capella_delete_document_by_id", "capella_upsert_document_by_id"],
				// All three verified zero-arg-OK against the live server, and this cluster serves
				// production traffic, so an empty result from any of them is a genuine finding.
				knownGoodAnchors: [
					{ toolName: "capella_get_longest_running_queries", mustReturnRows: true },
					{ toolName: "capella_get_completed_requests", mustReturnRows: true },
				],
			},
		},
		metadata: { ticketKey: "SIO-1398-couchbase-query-profile", queryProvenance: "reconstructed", era: "2026-08" },
	},
	{
		inputs: {
			query: `Audit the Couchbase index estate: list the system indexes and their detail, flag any indexes that are candidates to drop, and report which queries are running against a primary index or without a covering index. Also show the scope and collection layout.`,
			uiSelectedDataSources: ["couchbase"],
		},
		outputs: {
			expectedDatasources: ["couchbase"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name real indexes, report drop candidates (or state there are none), and identify primary-index or non-covering query patterns. A production cluster always has indexes and a scope layout, so an empty structural answer is a tool problem rather than a finding.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "couchbase",
						anyOf: ["capella_get_system_indexes", "capella_get_detailed_indexes"],
						why: "index_analysis -- capella_get_system_indexes is in RESOLUTION_TOOLS_BY_DATASOURCE (force-included every turn) and capella_get_detailed_indexes is zero-arg despite my earlier claim that it needed a discovery step",
					},
					{
						dataSource: "couchbase",
						anyOf: ["capella_get_indexes_to_drop", "capella_get_primary_index_queries"],
						why: "both runbook-cited (database-slow-queries), both zero-arg, and neither had ever been exercised",
					},
					{
						dataSource: "couchbase",
						anyOf: ["capella_get_scopes_and_collections"],
						why: "force-included via RESOLUTION; single-tool group so a miss isolates tool selection from argument correctness",
					},
				],
				forbiddenTools: ["capella_delete_document_by_id", "capella_upsert_document_by_id"],
				knownGoodAnchors: [
					{ toolName: "capella_get_system_indexes", mustReturnRows: true },
					{ toolName: "capella_get_scopes_and_collections", mustReturnRows: true },
				],
			},
		},
		metadata: { ticketKey: "SIO-1398-couchbase-index-audit", queryProvenance: "reconstructed", era: "2026-08" },
	},
	// Nearly every AWS tool requires `estate` and nothing else -- and uiSelectedAwsEstates already
	// supplies it, so the "NEEDS-ARGS" majority on this datasource is largely already satisfied.
	// The ECS detail tools additionally need `cluster`, which is why a verified cluster name is
	// named in the prompt.
	{
		inputs: {
			query: `In the ${LIVE_ANCHORS.aws.estates[0]} AWS estate, list the CloudWatch log groups, and report which tasks are running on the ${LIVE_ANCHORS.aws.ecsCluster} ECS cluster.`,
			uiSelectedDataSources: ["aws"],
			uiSelectedAwsEstates: [LIVE_ANCHORS.aws.estates[0]],
		},
		outputs: {
			expectedDatasources: ["aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should name real log groups and the running tasks on the named cluster. A production estate always has both, so an empty answer points at AssumeRole or arguments rather than at reality.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "aws",
						anyOf: ["aws_logs_describe_log_groups", "aws_logs_start_query"],
						why: "logs_insights action group -- both runbook-cited AND in RESOLUTION_TOOLS_BY_DATASOURCE; both require only `estate`, which the UI pin supplies",
					},
					{
						dataSource: "aws",
						anyOf: ["aws_ecs_list_tasks", "aws_ecs_describe_tasks"],
						why: "force-included via RESOLUTION, and aws_ecs_list_tasks was the SIO-1255 unbound-tool defect. Both require `cluster`, so the prompt names a cluster verified live via aws_ecs_list_clusters",
					},
				],
				knownGoodAnchors: [{ toolName: "aws_logs_describe_log_groups", mustReturnRows: true }],
			},
		},
		metadata: { ticketKey: "SIO-1398-aws-logs-and-tasks", queryProvenance: "reconstructed", era: "2026-08" },
	},
	{
		inputs: {
			query: `Give me an infrastructure inventory for the ${LIVE_ANCHORS.aws.estates[1]} AWS estate: EC2 instances, RDS database instances, and any active AWS Health events affecting the account.`,
			uiSelectedDataSources: ["aws"],
			uiSelectedAwsEstates: [LIVE_ANCHORS.aws.estates[1]],
		},
		outputs: {
			expectedDatasources: ["aws"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should inventory compute and database resources for the estate and report Health events (or state plainly that there are none, which is the healthy case). An empty inventory across all three categories indicates an AssumeRole problem rather than an empty account.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "aws",
						anyOf: ["aws_ec2_describe_instances", "aws_ec2_describe_security_groups"],
						why: "ec2_state is the largest AWS action group (12 tools) and was entirely unexercised; both require only `estate`",
					},
					{
						dataSource: "aws",
						anyOf: ["aws_rds_describe_db_instances"],
						why: "rds_state -- runbook-cited, requires only `estate`, and SIO-1331 recorded it as unreachable via keyword match (0/2 live replays), so pinning it here is a direct regression check",
					},
					{
						dataSource: "aws",
						anyOf: ["aws_health_describe_events"],
						why: "health_events -- runbook-cited (aws-msk-broker-unreachable), single-tool group so a miss isolates selection from arguments",
					},
				],
			},
		},
		metadata: { ticketKey: "SIO-1398-aws-infra-inventory", queryProvenance: "reconstructed", era: "2026-08" },
	},
	{
		inputs: {
			query: `Search Jira on ${LIVE_ANCHORS.atlassian.site} for incidents related to the ${LIVE_ANCHORS.elastic.service} service, and report any linked or recurring incidents.`,
			uiSelectedDataSources: ["atlassian"],
		},
		outputs: {
			expectedDatasources: ["atlassian"],
			minConfidence: 0.6,
			qualityRubric:
				"Response should report linked or prior incidents for the named service, or state clearly that none were found. Either outcome is legitimate; the lookup itself must happen.",
			expectedToolUse: {
				requiredToolGroups: [
					{
						dataSource: "atlassian",
						anyOf: ["findLinkedIncidents", "atlassian_search", "getIncidentHistory"],
						why: "incident_correlation action group -- findLinkedIncidents is the SOLE input to the atlassian typed extractor (SIO-1182) and atlassian_search is force-included via RESOLUTION; atlassian had the worst coverage of any datasource at 0/2",
					},
				],
				forbiddenTools: ["atlassian_createJiraIssue", "atlassian_editJiraIssue"],
			},
		},
		metadata: { ticketKey: "SIO-1398-atlassian-linked-incidents", queryProvenance: "reconstructed", era: "2026-08" },
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
