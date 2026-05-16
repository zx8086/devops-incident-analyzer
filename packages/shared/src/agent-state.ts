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
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
