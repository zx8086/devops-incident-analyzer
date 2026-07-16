// shared/src/agent-state.ts
import { z } from "zod";
import { PendingActionSchema } from "./action-types.ts";
import { HilMatchCandidateSchema, LearningProposalSchema } from "./hil-learning.ts";

export const ToolOutputSchema = z.object({
	toolName: z.string(),
	rawJson: z.unknown(),
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

// SIO-1087: the coarse bucket the aggregator/loop-guard act on. Widened beyond the original
// auth|session|transient|unknown so a routine outcome no longer masquerades as a failure:
//   not-found  -- a named resource/index does not exist. NON-retryable (retrying never resolves it),
//                 but it is a normal finding, not a malfunction.
//   bad-query  -- the query STRING/DSL is malformed (fix the query, not the window/retry).
//   no-data    -- an expected discovery outcome (e.g. a collection with no index, an empty result
//                 that is informative). MUST NOT count toward the degraded-subagent confidence cap.
//   server-error -- upstream 5xx / $fault:"server". Retryable.
export const ToolErrorCategorySchema = z.enum([
	"auth",
	"session",
	"transient",
	"not-found",
	"bad-query",
	"no-data",
	"server-error",
	"unknown",
]);
export type ToolErrorCategory = z.infer<typeof ToolErrorCategorySchema>;

// SIO-1087: the fine-grained, cross-datasource error kind. Each MCP server maps its OWN SDK's
// documented error type (couchbase instanceof + first_error_code, elastic meta.body.error.type,
// aws err.name/$fault/httpStatusCode, kafka .code/apiCode/canRetry, konnect axios status, gitlab/
// atlassian HTTP status) onto one of these. The agent classifies on `kind` (structured) instead of
// regexing message text. `category` is the coarse bucket derived from `kind` via
// TOOL_ERROR_KIND_TO_CATEGORY below. Hoisted here (was bespoke to mcp-server-aws) so all seven
// servers + the agent share ONE vocabulary.
export const ToolErrorKindSchema = z.enum([
	// auth / session
	"auth-denied", // 401/403, security_exception, IAM/permission missing, invalid credentials
	"assume-role-denied", // AWS STS AssumeRole trust failure (kept distinct: different remediation)
	"auth-expired", // OAuth/token/session expired -- re-auth needed, NON-retryable
	// bad input / query
	"bad-query", // malformed query STRING/DSL (fix the query; do not re-anchor/retry as-is)
	"bad-input", // other client-side validation failure (bad param, out-of-range)
	// not found / no data
	"not-found", // named resource/index/log-group/topic does not exist -- NON-retryable finding
	"no-index", // couchbase planning failure: collection exists but has no queryable index (no-data)
	"query-window", // AWS CloudWatch retention/creation window rejection -- re-anchor the window
	// transient / server
	"throttled", // rate-limited / 429 / too_many_requests / circuit_breaking
	"timeout", // request timeout
	"network", // connection reset/refused, socket hang up
	"server-error", // upstream 5xx / $fault:"server"
	// fallback
	"unknown",
]);
export type ToolErrorKind = z.infer<typeof ToolErrorKindSchema>;

// SIO-1087: single source of truth mapping the fine-grained kind -> the coarse category the
// aggregator degraded-rate math and loop guard consume. `retryable` is derived from the category
// (transient/server-error are worth a retry; everything else is not).
export const TOOL_ERROR_KIND_TO_CATEGORY: Record<ToolErrorKind, ToolErrorCategory> = {
	"auth-denied": "auth",
	"assume-role-denied": "auth",
	"auth-expired": "session",
	"bad-query": "bad-query",
	"bad-input": "unknown",
	"not-found": "not-found",
	"no-index": "no-data",
	"query-window": "bad-query", // a fixable query-window mistake, not a transient failure
	throttled: "transient",
	timeout: "transient",
	network: "transient",
	"server-error": "server-error",
	unknown: "unknown",
};

// SIO-1087: categories whose errors are worth retrying. Everything else (auth/bad-query/not-found/
// no-data/unknown) never succeeds on a blind retry, so the loop guard must stop re-issuing.
const RETRYABLE_CATEGORIES: ReadonlySet<ToolErrorCategory> = new Set<ToolErrorCategory>(["transient", "server-error"]);
export function isRetryableCategory(category: ToolErrorCategory): boolean {
	return RETRYABLE_CATEGORIES.has(category);
}

// SIO-1087: categories that are routine discovery outcomes, NOT tool malfunctions. Excluded from
// the >15% degraded-subagent confidence cap so a collection-with-no-index or a non-existent log
// group never drags confidence below the HITL gate.
const NON_DEGRADING_CATEGORIES: ReadonlySet<ToolErrorCategory> = new Set<ToolErrorCategory>(["no-data", "not-found"]);
export function isDegradingCategory(category: ToolErrorCategory): boolean {
	return !NON_DEGRADING_CATEGORIES.has(category);
}

export const ToolErrorSchema = z.object({
	toolName: z.string(),
	category: ToolErrorCategorySchema,
	// SIO-1087: the fine-grained SDK-mapped kind. Optional for backward-compat with fallback
	// (regex) classification that only produces a category; present whenever a server emits the
	// structured envelope.
	kind: ToolErrorKindSchema.nullish(),
	message: z.string(),
	retryable: z.boolean(),
	// SIO-725: upstream host that produced the error, sourced from MCP-side new URL(baseUrl).hostname.
	// SIO-728: populated end-to-end via the ---STRUCTURED--- sentinel in ResponseBuilder.error.
	hostname: z.string().nullish(),
	// SIO-729: content-type the upstream actually returned (e.g. "text/html" for nginx 503 pages).
	// Lets correlation rules distinguish service-degraded from malformed-JSON.
	upstreamContentType: z.string().nullish(),
	// SIO-728: real HTTP status from the upstream, so rules don't have to regex 5\d\d out of message.
	statusCode: z.number().int().nullish(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

// SIO-764: Per-domain structured findings derived from toolOutputs[] by the
// extractFindings graph node. Optional; absence = no extraction ran or
// extractor soft-failed. Each agent gets its own *Findings field; rules
// read the typed sibling instead of casting result.data through unknown.
export const KafkaFindingsSchema = z.object({
	consumerGroups: z
		.array(
			z.object({
				id: z.string(),
				state: z.string().optional(),
				totalLag: z.number().optional(),
			}),
		)
		.optional(),
	dlqTopics: z
		.array(
			z.object({
				name: z.string(),
				totalMessages: z.number(),
				recentDelta: z.number().nullable(),
			}),
		)
		.optional(),
	// SIO-785 follow-up (2026-05-18): summary fields surfaced by KafkaFindingsCard.
	// Cluster: from kafka_describe_cluster (MSK admin API).
	cluster: z
		.object({
			provider: z.string().optional(),
			brokerCount: z.number().int().optional(),
			topicCount: z.number().int().optional(),
			controllerId: z.number().int().optional(),
		})
		.optional(),
	// Connectors: from connect_list_connectors. State is uppercase Confluent state
	// (RUNNING, PAUSED, FAILED, UNASSIGNED). taskFailures counts non-RUNNING tasks.
	connectors: z
		.array(
			z.object({
				name: z.string(),
				state: z.string(),
				type: z.string().optional(), // "sink" | "source"
				taskFailures: z.number().int().optional(),
			}),
		)
		.optional(),
	// ksqlDB queries: from ksql_list_queries. statusCount is the per-replica
	// state distribution emitted by ksqlDB (e.g. {RUNNING: 1, UNRESPONSIVE: 2}).
	ksqlQueries: z
		.array(
			z.object({
				id: z.string(),
				state: z.string(),
				queryType: z.string().optional(),
				statusCount: z.record(z.string(), z.number().int()).optional(),
			}),
		)
		.optional(),
});
export type KafkaFindings = z.infer<typeof KafkaFindingsSchema>;

// SIO-771: mirrors GitLab REST /merge_requests response fields the
// gitlab-deploy-vs-datastore-runtime rule consumes. snake_case matches the
// upstream API exactly so the extractor stays a pass-through validator.
export const GitLabMergedRequestSchema = z.object({
	id: z.union([z.number(), z.string()]),
	project_id: z.number().int().optional(),
	title: z.string().optional(),
	description: z.string().optional(),
	merged_at: z.string().optional(),
	web_url: z.string().optional(),
});
export type GitLabMergedRequest = z.infer<typeof GitLabMergedRequestSchema>;

export const GitLabFindingsSchema = z.object({
	mergedRequests: z.array(GitLabMergedRequestSchema).optional(),
});
export type GitLabFindings = z.infer<typeof GitLabFindingsSchema>;

// SIO-1076: GitLab Orbit cross-project knowledge-graph findings. Source: the
// gitlab datasource's Orbit tools (query_graph over the pvhcorp ClickHouse
// graph). Distinct from GitLabFindings (per-project REST): every row here is
// cross-project and default-branch-only. All entity ids come back as strings.

// A changed definition from a deploy MR, plus the downstream projects/files that
// IMPORT it -- the "shared library change breaks N services" signal impossible
// with per-project REST.
export const OrbitBlastRadiusSchema = z.object({
	definitionName: z.string().describe("Fully-qualified definition (function/class/module) that changed"),
	definitionKind: z.string().optional().describe("Orbit Definition kind: function | class | module"),
	sourceProject: z.string().optional().describe("pvhcorp project path where the definition is DEFINED"),
	sourceFile: z.string().optional().describe("File path of the definition on the default branch"),
	mrId: z.union([z.number(), z.string()]).optional().describe("MergeRequest id whose diff touched the definition"),
	mrMergedAt: z.string().optional().describe("ISO merge timestamp; used for post-merge time-ordering"),
	mrWebUrl: z.string().optional().describe("Link to the MR for the report"),
	importedByProjects: z.array(z.string()).describe("Distinct pvhcorp projects that IMPORT the definition (downstream)"),
	importedByFiles: z
		.array(
			z.object({
				project: z.string().optional().describe("Downstream project path"),
				file: z.string().describe("Downstream file that imports the changed symbol"),
			}),
		)
		.describe("Concrete import sites (project+file) for the report and rule scoping"),
	importSiteCount: z.number().int().describe("Total IMPORTS edges resolved (may exceed importedByFiles length)"),
});
export type OrbitBlastRadius = z.infer<typeof OrbitBlastRadiusSchema>;

// A recent deploy MR ranked across the whole group in the incident window.
export const OrbitRecentDeploySchema = z.object({
	mrId: z.union([z.number(), z.string()]),
	project: z.string().optional().describe("pvhcorp project path the MR merged into"),
	title: z.string().optional(),
	mergedAt: z.string().describe("ISO merge timestamp"),
	author: z.string().optional().describe("AUTHORED-edge user, for escalation tagging"),
	changedFileCount: z.number().int().optional().describe("HAS_DIFF -> MergeRequestDiffFile count"),
	webUrl: z.string().optional(),
});
export type OrbitRecentDeploy = z.infer<typeof OrbitRecentDeploySchema>;

// Ranked pipeline/job failures across projects in the window (source=merge_request_event).
export const OrbitPipelineFailureSchema = z.object({
	project: z.string().optional(),
	pipelineId: z.union([z.number(), z.string()]).optional(),
	ref: z.string().optional().describe("Pipeline ref / branch"),
	jobName: z.string().optional().describe("Job node name when resolvable"),
	failureCount: z.number().int().describe("Repeated-failure count for this project/ref in the window"),
	lastFailedAt: z.string().optional(),
});
export type OrbitPipelineFailure = z.infer<typeof OrbitPipelineFailureSchema>;

// Critical/high vulnerabilities tied to a project (and, where resolvable, a recent MR).
export const OrbitVulnerabilitySchema = z.object({
	vulnerabilityId: z.union([z.number(), z.string()]).optional(),
	title: z.string().optional(),
	severity: z.string().describe("Orbit Vulnerability severity: critical | high | medium | low"),
	project: z.string().optional(),
	reportType: z.string().optional().describe("Scanner report type (e.g. sast, dependency_scanning)"),
	introducedByMrId: z.union([z.number(), z.string()]).optional().describe("MR resolved via SecurityScan -> MR"),
	introducedAt: z.string().optional(),
	file: z.string().optional(),
});
export type OrbitVulnerability = z.infer<typeof OrbitVulnerabilitySchema>;

export const OrbitFindingsSchema = z.object({
	blastRadius: z
		.array(OrbitBlastRadiusSchema)
		.optional()
		.describe("Populated only on a targeted blast-radius query, never speculatively"),
	recentDeploys: z.array(OrbitRecentDeploySchema).optional(),
	pipelineFailures: z.array(OrbitPipelineFailureSchema).optional(),
	vulnerabilities: z.array(OrbitVulnerabilitySchema).optional(),
});
export type OrbitFindings = z.infer<typeof OrbitFindingsSchema>;

// SIO-772: rows emitted by n1qlLongestRunningQueries + lastExecutionTime column.
export const CouchbaseSlowQuerySchema = z.object({
	statement: z.string(),
	avgServiceTime: z.string().optional(),
	lastExecutionTime: z.string().optional(),
	queries: z.number().int().optional(),
});
export type CouchbaseSlowQuery = z.infer<typeof CouchbaseSlowQuerySchema>;

export const CouchbaseFindingsSchema = z.object({
	slowQueries: z.array(CouchbaseSlowQuerySchema).optional(),
	unscoped: z
		.boolean()
		.optional()
		.describe(
			"SIO-1138: true when no statement matched the focus services or focus-linked keyspaces and slowQueries is a top-N cluster-wide fallback; rule-engine consumers must skip unscoped rows",
		),
});
export type CouchbaseFindings = z.infer<typeof CouchbaseFindingsSchema>;

// SIO-785 follow-up (2026-05-18): minimal Elastic findings. Today surfaces the
// most-deterministic structured signal the elastic sub-agent produces during
// incident analysis: synthetic monitor status. The SOUL's Synthetic-Monitor
// Cross-Check rule (SIO-717) mandates these queries when investigating Confluent
// service outages, so the tool output shape is stable across runs. Extend with
// new fields (APM service summary, top error log clusters) when those signals
// stabilise.
export const ElasticSyntheticMonitorSchema = z.object({
	name: z.string(),
	status: z.string(), // "up" / "down"
	url: z.string().optional(),
	observedAt: z.string().optional(),
	geo: z.string().optional(),
});
export type ElasticSyntheticMonitor = z.infer<typeof ElasticSyntheticMonitorSchema>;

// SIO-787 (SIO-778 Phase B, 2026-05-18): one row per APM service observed in the
// `traces-apm-*` aggregation window. `serviceName` mirrors the document field
// `service.name` verbatim -- this means the eu-b2b plural form
// (`notifications-service`) on prod, NOT the Kafka group-id singular form
// (`notification-service`). See memory `reference_b2b_apm_service_naming`. Any
// future rule that joins this against `kafkaFindings.consumerGroups[]` must
// normalise (Phase D, deferred to SIO-773).
export const ElasticApmServiceSchema = z.object({
	serviceName: z.string(),
	environment: z.string().optional(),
	errorRate: z.number().optional(),
	transactionCount: z.number().optional(),
	avgDurationMs: z.number().optional(),
	observedAt: z.string().optional(),
});
export type ElasticApmService = z.infer<typeof ElasticApmServiceSchema>;

// SIO-788 (SIO-778 Phase C, 2026-05-18): one row per distinct error-message
// cluster from `logs-*`. Clustering is client-side: signature is sha1(hex,16)
// of the sorted distinctive-token set from `_source.message`. `sampleMessage`
// preserves the first observed message verbatim. `service` is the modal
// `_source.service` value when one dominates the cluster (>=50%); otherwise
// omitted. Top 10 clusters by `count` desc.
export const ElasticLogClusterSchema = z.object({
	signature: z.string(),
	sampleMessage: z.string(),
	count: z.number(),
	level: z.string(),
	service: z.string().optional(),
	firstSeen: z.string().optional(),
	lastSeen: z.string().optional(),
});
export type ElasticLogCluster = z.infer<typeof ElasticLogClusterSchema>;

export const ElasticFindingsSchema = z.object({
	syntheticMonitors: z.array(ElasticSyntheticMonitorSchema).optional(),
	apmServices: z.array(ElasticApmServiceSchema).optional(),
	logClusters: z.array(ElasticLogClusterSchema).optional(),
});
export type ElasticFindings = z.infer<typeof ElasticFindingsSchema>;

// SIO-785 Phase 2 (2026-05-18): AWS CloudWatch alarm findings.
// Source: aws_cloudwatch_describe_alarms returns `{MetricAlarms: [...]}` with
// PascalCase SDK fields. The extractor maps them to camelCase here so the
// card stays consistent with the other findings types. CompositeAlarms are
// out of scope for v1 (rarely the triage signal); add a sibling field when
// composite triage becomes a real use case.
export const AwsCloudWatchAlarmSchema = z.object({
	name: z.string(),
	state: z.string(), // "OK" | "ALARM" | "INSUFFICIENT_DATA"
	reason: z.string().optional(),
	metricName: z.string().optional(),
	namespace: z.string().optional(),
	stateUpdatedAt: z.string().optional(),
});
export type AwsCloudWatchAlarm = z.infer<typeof AwsCloudWatchAlarmSchema>;

export const AwsFindingsSchema = z.object({
	alarms: z.array(AwsCloudWatchAlarmSchema).optional(),
});
export type AwsFindings = z.infer<typeof AwsFindingsSchema>;

// SIO-785 Phase 2 (2026-05-18): Atlassian linked-incident findings.
// Source: the custom `findLinkedIncidents` tool (packages/mcp-server-atlassian/
// src/tools/custom/find-linked-incidents.ts) emits a shaped envelope
// `{service, jql, count, issues: ShapedIssue[]}`. We mirror the upstream
// ShapedIssue camelCase here verbatim; the extractor reads `rawJson.issues`.
export const AtlassianLinkedIssueSchema = z.object({
	key: z.string(),
	summary: z.string(),
	status: z.string(),
	severity: z.string().nullable().optional(),
	createdAt: z.string().optional(),
	resolvedAt: z.string().nullable().optional(),
	mttrMinutes: z.number().nullable().optional(),
	url: z.string().optional(),
});
export type AtlassianLinkedIssue = z.infer<typeof AtlassianLinkedIssueSchema>;

export const AtlassianFindingsSchema = z.object({
	linkedIssues: z.array(AtlassianLinkedIssueSchema).optional(),
});
export type AtlassianFindings = z.infer<typeof AtlassianFindingsSchema>;

export const DataSourceResultSchema = z.object({
	dataSourceId: z.string(),
	// SIO-649: Populated when the elastic sub-agent fans out across deployments.
	deploymentId: z.string().optional(),
	data: z.unknown(),
	status: z.enum(["pending", "running", "success", "error"]),
	duration: z.number().optional(),
	toolOutputs: z.array(ToolOutputSchema).optional(),
	isAlignmentRetry: z.boolean().optional(),
	error: z.string().optional(),
	toolErrors: z.array(ToolErrorSchema).optional(),
	// SIO-764: structured findings derived from toolOutputs[] in extractFindings node.
	kafkaFindings: KafkaFindingsSchema.optional(),
	gitlabFindings: GitLabFindingsSchema.optional(),
	// SIO-1076: Orbit cross-project findings ride the gitlab DataSourceResult.
	orbitFindings: OrbitFindingsSchema.optional(),
	couchbaseFindings: CouchbaseFindingsSchema.optional(),
	// SIO-785 follow-up (2026-05-18).
	elasticFindings: ElasticFindingsSchema.optional(),
	// SIO-785 Phase 2 (2026-05-18): AWS CloudWatch + Atlassian linked incidents.
	awsFindings: AwsFindingsSchema.optional(),
	atlassianFindings: AtlassianFindingsSchema.optional(),
	// SIO-707: total LangGraph messages produced by the sub-agent run. Used by the aggregator
	// to compute a tool-error rate (toolErrors.length / messageCount) and cap confidence when
	// the run completed but had a high per-iteration failure ratio.
	messageCount: z.number().optional(),
});
export type DataSourceResult = z.infer<typeof DataSourceResultSchema>;

export const ToolPlanStepSchema = z.object({
	tool: z.string(),
	args: z.record(z.string(), z.unknown()),
});
export type ToolPlanStep = z.infer<typeof ToolPlanStepSchema>;

export const ExtractedEntitiesSchema = z.object({
	dataSources: z.array(
		z.object({
			id: z.string(),
			mentionedAs: z.string(),
		}),
	),
	toolActions: z.record(z.string(), z.array(z.string())).optional(),
});
export type ExtractedEntities = z.infer<typeof ExtractedEntitiesSchema>;

// SIO-630: Structured incident data produced by the normalize node
export const NormalizedIncidentSchema = z.object({
	severity: z.enum(["critical", "high", "medium", "low"]).optional(),
	timeWindow: z.object({ from: z.string(), to: z.string() }).optional(),
	affectedServices: z
		.array(z.object({ name: z.string(), namespace: z.string().optional(), deployment: z.string().optional() }))
		.optional(),
	extractedMetrics: z
		.array(z.object({ name: z.string(), value: z.string().optional(), threshold: z.string().optional() }))
		.optional(),
});
export type NormalizedIncident = z.infer<typeof NormalizedIncidentSchema>;

// SIO-750: Investigation focus anchor. Established on the first complex turn
// of a chat session and inherited across turns via the LangGraph checkpointer.
// All prompts that run on follow-up turns (normalizer, entity-extractor,
// sub-agent, aggregator) consume this so the LLM does not drift to unrelated
// services, datasources, or time ranges. Replaced only by an explicit
// "fresh" decision from the topic-shift HITL gate (Layer C).
export const InvestigationFocusSchema = z.object({
	services: z.array(z.string()),
	datasources: z.array(z.string()),
	timeWindow: z
		.object({
			from: z.string(),
			to: z.string(),
		})
		.optional(),
	summary: z.string(),
	establishedAtTurn: z.number(),
});
export type InvestigationFocus = z.infer<typeof InvestigationFocusSchema>;

// SIO-1084: Per-datasource canonical identifiers resolved BEFORE the sub-agent
// fan-out by the resolveIdentifiers node. The loose incident service token (e.g.
// "order-service") is enumerated against each store's real namespace so the
// sub-agent queries the identifier that actually exists instead of guessing.
// Every datasource block is optional (out of scope, disabled, or a failed probe
// simply omits its block). Injected into each sub-agent's focus block. Per-turn
// (replace reducer, NOT sticky) and stamped so a stale prior-turn resolution is
// never rendered against a different service set.
export const ResolvedIdentifiersSchema = z.object({
	// Staleness stamps: the turn (messages.length) and the focus.services snapshot
	// this resolution answers. The focus block only renders when resolvedForServices
	// still set-equals the current focus.services.
	resolvedForTurn: z.number(),
	resolvedForServices: z.array(z.string()),
	elastic: z.object({ serviceNames: z.array(z.string()) }).optional(),
	// SIO-1087: `scopes` = every scope -> its collection names (enumerated, never filtered).
	// SIO-1088: `indexInfo` = scope -> collection -> { hasPrimary, secondaryKeyFields }. A bare
	// SELECT * needs a PRIMARY index; a collection with only SECONDARY indexes rejects SELECT *
	// ("no index available") but IS queryable via a WHERE leading on a secondary index key. The
	// focus block tags [PRIMARY - SELECT * ok] vs [SECONDARY ONLY - query WHERE on: <fields>] so the
	// agent stops mistaking a SELECT * no-index failure for missing data. Absent = index probe
	// unavailable/failed; the renderer then omits the tag rather than falsely guessing.
	couchbase: z
		.object({
			scopes: z.record(z.string(), z.array(z.string())),
			indexInfo: z
				.record(
					z.string(),
					z.record(z.string(), z.object({ hasPrimary: z.boolean(), secondaryKeyFields: z.array(z.string()) })),
				)
				.optional(),
			// SIO-1107: bucket-aware discovery (all optional -- old checkpointed payloads parse
			// unchanged; absent when the server lacks capella_get_buckets). `scopes`/`indexInfo`
			// above always describe the DEFAULT bucket; `otherBucketScopes` maps probed
			// non-default buckets -> scope -> collections (no index info -- the focus block
			// tells the agent to discover indexes per bucket before querying).
			defaultBucket: z.string().optional(),
			buckets: z.array(z.string()).optional(),
			otherBucketScopes: z.record(z.string(), z.record(z.string(), z.array(z.string()))).optional(),
		})
		.optional(),
	aws: z.object({ logGroups: z.array(z.string()), ecsServices: z.array(z.string()).optional() }).optional(),
	kafka: z.object({ topics: z.array(z.string()), consumerGroups: z.array(z.string()) }).optional(),
	konnect: z
		.object({
			controlPlaneId: z.string().optional(),
			controlPlaneName: z.string().optional(),
			serviceIds: z.array(z.string()).optional(),
		})
		.optional(),
	gitlab: z.object({ projectId: z.string().optional(), pathWithNamespace: z.string().optional() }).optional(),
	// SIO-1096: no `atlassian` field -- the atlassian resolveIdentifiers probe was removed. Jira
	// projects are team/org-named, not service-named, so a service->project name-match resolved
	// nothing; the atlassian sub-agent searches all projects by incident domain terms instead.
	// SIO-1101 (R7): identifiers that came from the knowledge graph (prior investigations' W8
	// bindings) and were NOT independently re-found by a probe this turn. A flat list across
	// datasources; the per-datasource blocks above already CONTAIN these values (they are merged
	// in), and this field just marks WHICH are graph-only so the focus block can render them as
	// "known coordinates, not probed this turn -- verify before relying" rather than as this
	// turn's probe output. Absent/empty when nothing was graph-seeded.
	graphSeeded: z.array(z.string()).optional(),
});
export type ResolvedIdentifiers = z.infer<typeof ResolvedIdentifiersSchema>;

// SIO-1103: one runtime shared-infrastructure blast-radius hit -- another service that
// could be affected via a shared runtime dependency of an incident service. Populated by
// graphEnrich from the KG (blastRadiusForServices) so the SYNCHRONOUS correlation rule
// trigger can read it from state. Distinct from GitLab Orbit's cross-project code radius.
export const GraphBlastRadiusHitSchema = z.object({
	service: z.string(), // the incident service the hit is anchored to
	neighbour: z.string(), // the potentially-affected other service
	// SIO-1104 (5a): aws-resource = another service RUNS_ON the same AwsResource
	// (populated by the scheduled topology sweep's ECS enumeration).
	via: z.enum(["depends-on", "kafka-topic", "telemetry-source", "aws-resource"]),
	sharedResource: z.string(), // the shared thing (topic/telemetry id/arn); "" for depends-on
});
export type GraphBlastRadiusHit = z.infer<typeof GraphBlastRadiusHitSchema>;

// SIO-631: Mitigation steps produced by the propose-mitigation node
export const MitigationStepsSchema = z.object({
	investigate: z.array(z.string()),
	monitor: z.array(z.string()),
	escalate: z.array(z.string()),
	relatedRunbooks: z.array(z.string()),
});
export type MitigationSteps = z.infer<typeof MitigationStepsSchema>;

export const DataSourceContextSchema = z.object({
	type: z.enum(["EXPLICIT", "INHERITED"]),
	dataSources: z.array(z.string()),
	inheritedFrom: z.string().optional(),
	scope: z.enum(["all", "subset", "merged"]),
});
export type DataSourceContext = z.infer<typeof DataSourceContextSchema>;

// SIO-935: version partition of a fleet-upgrade preview's resolved set. Optional on the two fleet
// events below so old CI reports (no version_crosstab) still validate.
export const FleetVersionCrosstabSchema = z.object({
	alreadyOnTarget: z.number(),
	outdated: z.number(),
	versionUnknown: z.number(),
	upgradeableOutdated: z.number(),
});

export const StreamEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("message"), content: z.string() }),
	z.object({
		type: z.literal("tool_call"),
		toolName: z.string(),
		args: z.record(z.string(), z.unknown()),
		dataSourceId: z.string().optional(),
	}),
	z.object({
		type: z.literal("datasource_progress"),
		dataSourceId: z.string(),
		status: z.enum(["pending", "running", "success", "error"]),
		message: z.string().optional(),
	}),
	// SIO-775: terminal per-datasource result with typed findings. Emitted once
	// per sub-agent at aggregate on_chain_end so the UI can render typed cards
	// (KafkaFindingsCard, etc.) inline. Distinct from datasource_progress
	// (lifecycle ticks). Findings fields are optional; absence = nothing to render.
	z.object({
		type: z.literal("datasource_result"),
		dataSourceId: z.string(),
		status: z.enum(["success", "error"]),
		duration: z.number().optional(),
		error: z.string().optional(),
		kafkaFindings: KafkaFindingsSchema.optional(),
		gitlabFindings: GitLabFindingsSchema.optional(),
		orbitFindings: OrbitFindingsSchema.optional(),
		couchbaseFindings: CouchbaseFindingsSchema.optional(),
		elasticFindings: ElasticFindingsSchema.optional(),
		// SIO-785 Phase 2 (2026-05-18).
		awsFindings: AwsFindingsSchema.optional(),
		atlassianFindings: AtlassianFindingsSchema.optional(),
	}),
	z.object({ type: z.literal("node_start"), nodeId: z.string() }),
	z.object({ type: z.literal("node_end"), nodeId: z.string(), duration: z.number() }),
	z.object({ type: z.literal("suggestions"), suggestions: z.array(z.string()) }),
	z.object({
		type: z.literal("done"),
		threadId: z.string(),
		requestId: z.string().optional(),
		runId: z.string().optional(),
		confidence: z.number().optional(),
		responseTime: z.number().optional(),
		toolsUsed: z.array(z.string()).optional(),
		dataSourceContext: DataSourceContextSchema.optional(),
		// SIO-930: the elastic-iac per-turn outcome, used to label the completion chip. Absent for
		// the incident agent (treated as "completed" by the reducer).
		outcome: z
			.enum(["completed", "rejected", "declined", "no-op", "blocked", "unsupported", "pipeline-failed"])
			.optional(),
	}),
	z.object({ type: z.literal("low_confidence"), message: z.string() }),
	z.object({
		type: z.literal("pending_actions"),
		actions: z.array(PendingActionSchema),
	}),
	z.object({ type: z.literal("error"), message: z.string() }),
	z.object({ type: z.literal("run_id"), runId: z.string() }),
	z.object({ type: z.literal("attachment_warnings"), warnings: z.array(z.string()) }),
	// SIO-751: graph paused on detectTopicShift; UI surfaces a "continue/fresh"
	// banner and POSTs the decision to /api/agent/topic-shift to resume.
	z.object({
		type: z.literal("topic_shift_prompt"),
		threadId: z.string(),
		oldFocusSummary: z.string(),
		newFocusSummary: z.string(),
		oldServices: z.array(z.string()),
		newServices: z.array(z.string()),
		message: z.string(),
	}),
	// SIO-751: emitted at the start of a resumed stream so the UI knows to
	// clear its banner before the resumed graph starts pushing events again.
	z.object({ type: z.literal("topic_shift_resolved") }),
	// SIO-1126: HIL learning lane ("learn from TICKET-123"). The match gate asks
	// which stored incident the ticket corresponds to; the review gate carries the
	// distilled proposal for per-item approve/reject. The UI POSTs the resume
	// value to /api/agent/learning/resume; hil_learning_resolved clears the card
	// at the start of a resumed stream (the topic_shift_resolved idiom).
	z.object({
		type: z.literal("hil_learning_match"),
		threadId: z.string(),
		ticketKey: z.string(),
		ticketSummary: z.string(),
		candidates: z.array(HilMatchCandidateSchema),
		message: z.string(),
	}),
	z.object({
		type: z.literal("hil_learning_review"),
		threadId: z.string(),
		ticketKey: z.string(),
		proposal: LearningProposalSchema,
		alreadyLearned: z.boolean(),
		// SIO-1130: the matched investigation surfaced on the review card -- the
		// match gate may have auto-confirmed (single ticket-mention pin) or
		// auto-created (zero candidates) without interrupting.
		matchedIncidentSummary: z.string().optional(),
		autoMatched: z.boolean().optional(),
		matchCreated: z.boolean().optional(),
		message: z.string(),
	}),
	z.object({ type: z.literal("hil_learning_resolved") }),
	// elastic-iac maker graph: a one-line clarification the planner needs, or the
	// plan-review gate. The UI POSTs the resume value to /api/agent/iac/resume.
	z.object({
		type: z.literal("iac_clarify"),
		threadId: z.string(),
		question: z.string(),
	}),
	z.object({
		type: z.literal("iac_plan_review"),
		threadId: z.string(),
		message: z.string(),
		review: z
			.object({
				cluster: z.string(),
				branch: z.string(),
				title: z.string(),
				diff: z.string(),
				plan: z.string(),
				risks: z.array(z.string()),
				precheckPassed: z.boolean(),
			})
			.nullable(),
	}),
	// SIO-876: live pipeline progress emitted by watchPipeline on each status change.
	// The final status + plan + approval still arrive as the assistant message.
	z.object({
		type: z.literal("iac_pipeline_progress"),
		pipelineId: z.number().nullable(),
		status: z.string(),
	}),
	// SIO-882: elastic-iac drift sub-flow. The full per-stack drift report (emitted once
	// by detectDrift), the per-stack reconcile-direction interrupt prompt, and a per-stack
	// result as each MR opens. The UI POSTs the chosen direction to /api/agent/iac/resume;
	// the agent never merges or applies. drift_report / reconcile_result are dispatched as
	// custom events (no threadId, like iac_pipeline_progress); reconcile_choice is an
	// interrupt surfaced with the thread's id.
	z.object({
		type: z.literal("iac_drift_report"),
		deployment: z.string(),
		stacks: z.array(
			z.object({
				stack: z.string(),
				drifted: z.boolean(),
				// SIO-882: true when iac_plan could not be read -- the stack was not assessed.
				planError: z.boolean().optional(),
				// SIO-887: human-readable reason for planError (state-lock / classified plan failure / ...).
				planErrorReason: z.string().optional(),
				kind: z.enum(["config-json", "unwired"]),
				create: z.number(),
				update: z.number(),
				delete: z.number(),
				// SIO-886: grounded explanation of what drifted (from explainDrift).
				explanation: z.string().optional(),
				resources: z.array(
					z.object({
						address: z.string(),
						actions: z.array(z.string()),
						// SIO-886: CI's human reason + the attributes that changed, so the UI shows WHAT drifted.
						reason: z.string().optional(),
						changedKeys: z.array(z.string()).optional(),
						category: z.string().optional(),
						// SIO-889: attribute-grain before/after; SIO-900: leaf-level changes[] so the UI can
						// expand exactly which nested leaves drifted (before = live, after = declared).
						values: z
							.record(z.string(), z.object({ before: z.unknown().optional(), after: z.unknown().optional() }))
							.optional(),
						changes: z
							.array(
								z.object({
									path: z.string(),
									op: z.enum(["add", "remove", "update"]),
									before: z.unknown().optional(),
									after: z.unknown().optional(),
									unstableIndex: z.boolean().optional(),
								}),
							)
							.optional(),
						changeCount: z.number().optional(),
						truncated: z.boolean().optional(),
					}),
				),
			}),
		),
	}),
	z.object({
		type: z.literal("iac_reconcile_choice"),
		threadId: z.string(),
		stack: z.string(),
		kind: z.enum(["config-json", "unwired"]),
		summary: z.string(),
		// SIO-886: the grounded explanation + per-resource detail surfaced in the choice card.
		explanation: z.string().optional(),
		resources: z
			.array(
				z.object({
					address: z.string(),
					actions: z.array(z.string()),
					reason: z.string().optional(),
					changedKeys: z.array(z.string()).optional(),
					// SIO-900: leaf-level detail + attribute-grain values for the reconcile-choice card.
					values: z
						.record(z.string(), z.object({ before: z.unknown().optional(), after: z.unknown().optional() }))
						.optional(),
					changes: z
						.array(
							z.object({
								path: z.string(),
								op: z.enum(["add", "remove", "update"]),
								before: z.unknown().optional(),
								after: z.unknown().optional(),
								unstableIndex: z.boolean().optional(),
							}),
						)
						.optional(),
					changeCount: z.number().optional(),
					truncated: z.boolean().optional(),
				}),
			)
			.optional(),
		directions: z.array(z.enum(["reconcile-to-json", "reconcile-to-live", "skip"])),
		message: z.string(),
	}),
	z.object({
		type: z.literal("iac_reconcile_result"),
		stack: z.string(),
		direction: z.enum(["reconcile-to-json", "reconcile-to-live", "skip"]),
		status: z.enum(["opened", "reused", "skipped", "blocked"]),
		mrUrl: z.string().optional(),
		note: z.string().optional(),
	}),
	// SIO-902: synthetics drift report (whole-deployment; from detectSyntheticsDrift).
	z.object({
		type: z.literal("synthetics_drift_report"),
		deployment: z.string(),
		kibanaUrl: z.string(),
		kibanaSpace: z.string(),
		hasActionableDrift: z.boolean(),
		planError: z.boolean().optional(),
		planErrorReason: z.string().optional(),
		totals: z.object({
			projectsChecked: z.number(),
			monitorsInSource: z.number(),
			monitorsInKibana: z.number(),
			missingInKibana: z.number(),
			extraInKibana: z.number(),
			changed: z.number(),
		}),
		drift: z.array(
			z.object({
				project: z.string(),
				monitorId: z.string(),
				monitorName: z.string(),
				category: z.enum(["changed", "missing_in_kibana", "extra_in_kibana"]),
				fields: z
					.array(z.object({ field: z.string(), source: z.unknown().optional(), live: z.unknown().optional() }))
					.optional(),
			}),
		),
		reconcilePlan: z.object({
			pushToKibana: z.object({
				command: z.string(),
				monitors: z.array(z.object({ project: z.string(), monitorId: z.string(), monitorName: z.string() })),
			}),
			addToSource: z.object({
				action: z.string(),
				monitors: z.array(z.object({ project: z.string(), monitorId: z.string(), monitorName: z.string() })),
			}),
		}),
	}),
	// SIO-902: the single operator push approve/decline interrupt, surfaced with the thread's id.
	z.object({
		type: z.literal("synthetics_push_choice"),
		threadId: z.string(),
		deployment: z.string(),
		kibanaSpace: z.string(),
		pushableCount: z.number(),
		extraCount: z.number(),
		projectScope: z.string().nullable(),
		command: z.string(),
		explanation: z.string().optional(),
		pushMonitors: z.array(z.object({ project: z.string(), monitorName: z.string() })),
		extraMonitors: z.array(z.object({ project: z.string(), monitorName: z.string() })),
		message: z.string(),
	}),
	// SIO-902: the single push outcome (from pushSynthetics).
	z.object({
		type: z.literal("synthetics_push_result"),
		status: z.enum(["pushed", "skipped", "blocked", "failed"]),
		pushedCount: z.number(),
		project: z.string().optional(),
		pipelineId: z.number().optional(),
		pipelineStatus: z.string().optional(),
		note: z.string().optional(),
	}),
	// SIO-913 / SIO-922: Fleet agent binary-upgrade sub-flow. The preview report (from
	// detectFleetUpgrade), the single operator approve/decline gate (fleetUpgradeGate), and the
	// apply outcome (applyFleetUpgrade). Mirrors the synthetics push trio.
	z.object({
		type: z.literal("fleet_upgrade_preview_report"),
		deployment: z.string(),
		targetVersion: z.string(),
		resolvedCount: z.number(),
		versionAvailable: z.boolean(),
		rolloutSeconds: z.number(),
		crosstab: z.object({
			upgradeable: z.number(),
			notUpgradeable: z.number(),
			byReason: z.array(z.object({ reason: z.string(), count: z.number() })),
		}),
		versionCrosstab: FleetVersionCrosstabSchema.optional(), // SIO-935
		planError: z.boolean().optional(),
		planErrorReason: z.string().optional(),
	}),
	// The single operator apply approve/decline interrupt, surfaced with the thread's id.
	z.object({
		type: z.literal("fleet_upgrade_choice"),
		threadId: z.string(),
		deployment: z.string(),
		targetVersion: z.string(),
		resolvedCount: z.number(),
		upgradeableCount: z.number(),
		notUpgradeableCount: z.number(),
		rolloutSeconds: z.number(),
		byReason: z.array(z.object({ reason: z.string(), count: z.number() })),
		versionCrosstab: FleetVersionCrosstabSchema.optional(), // SIO-935
		// SIO-971: rendered agent-memory recall of prior fleet upgrades for this deployment
		// (markdown). Absent when the agent-memory backend is off or recall found nothing.
		priorUpgrades: z.string().optional(),
		message: z.string(),
	}),
	// The single apply outcome (from applyFleetUpgrade). failedSilent is the verify-sweep
	// UPG_FAILED ground truth (Fleet action_status undercounts).
	z.object({
		type: z.literal("fleet_upgrade_apply_result"),
		status: z.enum(["applied", "skipped", "blocked", "failed"]),
		actionId: z.string().optional(),
		pollStatus: z.string().optional(),
		acked: z.number().optional(),
		created: z.number().optional(),
		failedSilent: z.number().optional(),
		pipelineId: z.number().optional(),
		// SIO-924: clickable link to the live bulk_upgrade apply pipeline.
		pipelineUrl: z.string().optional(),
		note: z.string().optional(),
	}),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
