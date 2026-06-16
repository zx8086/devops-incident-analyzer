// shared/src/agent-state.ts
import { z } from "zod";
import { PendingActionSchema } from "./action-types.ts";

export const ToolOutputSchema = z.object({
	toolName: z.string(),
	rawJson: z.unknown(),
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

export const ToolErrorCategorySchema = z.enum(["auth", "session", "transient", "unknown"]);
export type ToolErrorCategory = z.infer<typeof ToolErrorCategorySchema>;

export const ToolErrorSchema = z.object({
	toolName: z.string(),
	category: ToolErrorCategorySchema,
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
