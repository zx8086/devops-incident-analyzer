// knowledge-graph/src/schema.ts
//
// SIO-850: the knowledge graph data model. LadybugDB (a Kuzu successor) is
// table-typed -- node and relationship tables are declared up front, unlike
// Neo4j's schema-optional labels. Keeping the DDL and the typed labels/rels in
// ONE file is what makes the eventual Neo4j port a driver change, not a model
// change: a Neo4jStore consumes the same labels/rel-types and skips the DDL.

import { z } from "zod";

// Bedrock Titan Text Embeddings v2 output dimension.
export const EMBEDDING_DIM = 1024;

export const NODE_LABELS = [
	"Service",
	"Deployment",
	"KafkaTopic",
	"ConsumerGroup",
	"ApiRoute",
	"Bucket",
	"AwsAccount",
	"AwsResource",
	"Incident",
	"Finding",
	"Runbook",
	"WikiPage",
	// SIO-1026: a recurring incident root cause. Keyed by a stable hash of its
	// normalized class so repeat occurrences MERGE to one node; populated from the
	// pipeline's top satisfied correlation rule (never fabricated when none fired).
	"RootCause",
	// SIO-954: IaC (elastic-iac) concepts. An ElasticDeployment is a cluster
	// (distinct from a microservice Service); a ConfigChange is one maker turn's
	// proposed edit; a MergeRequest is the GitLab MR that carries it.
	"ElasticDeployment",
	"ConfigChange",
	"MergeRequest",
	// SIO-965: three-layer IaC repo model. The elastic-iac repo is modules/ (pure
	// logic, one resource type each) -> stacks/ (root modules wiring one module to
	// one backend state) -> environments/<deployment>/<stack>/ (config data). A
	// StackInstance is the (deployment, stack) state cell a ConfigChange targets;
	// it is a SPARSE matrix (not every stack runs on every deployment). Workflow,
	// Session and Pipeline promote per-turn strings/CI runs to first-class nodes.
	"Module",
	"Stack",
	"StackInstance",
	"Workflow",
	"Session",
	"Pipeline",
	// SIO-1038: one elastic-iac turn's VERBATIM user prompt. Keyed by requestId
	// (== the turn's ConfigChange id when it opens an MR, so a prompt links to its
	// change for free). RAW text, no truncation, no redaction.
	"Prompt",
] as const;
export type NodeLabel = (typeof NODE_LABELS)[number];

export const REL_TYPES = [
	"DEPENDS_ON",
	"PRODUCES_TO",
	"CONSUMES_FROM",
	"ROUTES_TO",
	"AFFECTED_BY",
	"CORRELATES_WITH",
	"RESOLVED_BY",
	"DOCUMENTED_IN",
	"DEPLOYED_AS",
	// SIO-1026: an Incident's derived root cause (from the top satisfied correlation).
	"HAS_ROOT_CAUSE",
	// SIO-954: IaC change history. CHANGED_BY links a deployment to a config
	// change; PROPOSED_IN links a config change to the MR that carries it.
	"CHANGED_BY",
	"PROPOSED_IN",
	// SIO-965: three-layer IaC edges. USES_MODULE is the real HCL Stack->Module
	// wiring (parsed from stacks/<name>/main.tf, can be many). OF_STACK/ON_DEPLOYMENT
	// place a StackInstance in the (stack, deployment) matrix. TARGETS gives a
	// ConfigChange (deployment, stack) precision; VIA_WORKFLOW/IN_SESSION attach the
	// turn's workflow + conversation; RAN attaches an MR's GitLab CI pipeline.
	"USES_MODULE",
	"OF_STACK",
	"ON_DEPLOYMENT",
	"TARGETS",
	"VIA_WORKFLOW",
	"IN_SESSION",
	"RAN",
	// SIO-1038: a turn's Prompt -> the Session (thread) it was asked in.
	"PROMPTED_IN",
] as const;
export type RelType = (typeof REL_TYPES)[number];

// Validated shapes for the writer boundary (parameters, never interpolated).
export const ServiceNodeSchema = z.object({ name: z.string().min(1) }).strict();
export const IncidentNodeSchema = z
	.object({
		id: z.string().min(1),
		severity: z.string().optional(),
		summary: z.string().optional(),
		createdAt: z.string().optional(),
	})
	.strict();
export const FindingNodeSchema = z
	.object({ id: z.string().min(1), kind: z.string(), summary: z.string().optional() })
	.strict();
// SIO-1026: the writer boundary shape for a RootCause node. The node is SHARED
// across incidents (PK = hash of the normalized class), so it carries only cause
// IDENTITY (id, class, description). Per-incident metadata (confidence, createdAt,
// ruleName) lives on the HAS_ROOT_CAUSE edge instead, so a later incident with the
// same cause class cannot overwrite an earlier incident's values.
export const RootCauseNodeSchema = z
	.object({
		id: z.string().min(1),
		class: z.string().optional(),
		description: z.string().optional(),
	})
	.strict();
// SIO-954: IaC writer boundary shapes.
export const DeploymentNodeSchema = z.object({ name: z.string().min(1) }).strict();
export const ConfigChangeNodeSchema = z
	.object({
		id: z.string().min(1),
		workflow: z.string().optional(),
		filePath: z.string().optional(),
		summary: z.string().optional(),
		createdAt: z.string().optional(),
	})
	.strict();
// SIO-965: three-layer IaC writer boundary shapes.
export const ModuleNodeSchema = z.object({ name: z.string().min(1), howto: z.string().optional() }).strict();
export const StackNodeSchema = z.object({ name: z.string().min(1) }).strict();
export const StackInstanceNodeSchema = z
	.object({ id: z.string().min(1), deployment: z.string().min(1), stack: z.string().min(1) })
	.strict();
export const WorkflowNodeSchema = z.object({ name: z.string().min(1) }).strict();
export const SessionNodeSchema = z.object({ threadId: z.string().min(1) }).strict();
// Pipeline.id is a STRING (the numeric GitLab pipeline id, stringified by the
// writer) for primary-key uniformity with every other node in the graph.
export const PipelineNodeSchema = z
	.object({ id: z.string().min(1), status: z.string().optional(), url: z.string().optional() })
	.strict();
// SIO-1038: verbatim per-turn user prompt. text holds the RAW, untruncated prompt.
export const PromptNodeSchema = z
	.object({
		id: z.string().min(1),
		text: z.string().optional(),
		agent: z.string().optional(),
		createdAt: z.string().optional(),
	})
	.strict();
export type ServiceNode = z.infer<typeof ServiceNodeSchema>;
export type IncidentNode = z.infer<typeof IncidentNodeSchema>;
export type FindingNode = z.infer<typeof FindingNodeSchema>;
export type RootCauseNode = z.infer<typeof RootCauseNodeSchema>;
export type DeploymentNode = z.infer<typeof DeploymentNodeSchema>;
export type ConfigChangeNode = z.infer<typeof ConfigChangeNodeSchema>;
export type ModuleNode = z.infer<typeof ModuleNodeSchema>;
export type StackNode = z.infer<typeof StackNodeSchema>;
export type StackInstanceNode = z.infer<typeof StackInstanceNodeSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type SessionNode = z.infer<typeof SessionNodeSchema>;
export type PipelineNode = z.infer<typeof PipelineNodeSchema>;
export type PromptNode = z.infer<typeof PromptNodeSchema>;

// Schema DDL. Kuzu/Ladybug node & rel tables, idempotent (IF NOT EXISTS). The
// embedding column on Incident backs the native vector index (see VECTOR_INDEX).
export const MIGRATIONS: readonly string[] = [
	"CREATE NODE TABLE IF NOT EXISTS Service(name STRING, PRIMARY KEY(name))",
	"CREATE NODE TABLE IF NOT EXISTS Deployment(id STRING, PRIMARY KEY(id))",
	"CREATE NODE TABLE IF NOT EXISTS KafkaTopic(name STRING, PRIMARY KEY(name))",
	"CREATE NODE TABLE IF NOT EXISTS ConsumerGroup(name STRING, PRIMARY KEY(name))",
	"CREATE NODE TABLE IF NOT EXISTS ApiRoute(path STRING, PRIMARY KEY(path))",
	"CREATE NODE TABLE IF NOT EXISTS Bucket(name STRING, PRIMARY KEY(name))",
	"CREATE NODE TABLE IF NOT EXISTS AwsAccount(id STRING, PRIMARY KEY(id))",
	"CREATE NODE TABLE IF NOT EXISTS AwsResource(arn STRING, PRIMARY KEY(arn))",
	`CREATE NODE TABLE IF NOT EXISTS Incident(id STRING, severity STRING, summary STRING, createdAt STRING, embedding DOUBLE[${EMBEDDING_DIM}], PRIMARY KEY(id))`,
	"CREATE NODE TABLE IF NOT EXISTS Finding(id STRING, kind STRING, summary STRING, PRIMARY KEY(id))",
	"CREATE NODE TABLE IF NOT EXISTS Runbook(filename STRING, PRIMARY KEY(filename))",
	"CREATE NODE TABLE IF NOT EXISTS WikiPage(slug STRING, PRIMARY KEY(slug))",
	// SIO-1026: RootCause (deterministic, no embedding). The node is shared across
	// incidents (PK = class hash) so it holds only cause identity; per-incident
	// confidence/createdAt live on the HAS_ROOT_CAUSE edge below.
	"CREATE NODE TABLE IF NOT EXISTS RootCause(id STRING, class STRING, description STRING, PRIMARY KEY(id))",
	"CREATE REL TABLE IF NOT EXISTS DEPENDS_ON(FROM Service TO Service)",
	"CREATE REL TABLE IF NOT EXISTS PRODUCES_TO(FROM Service TO KafkaTopic)",
	"CREATE REL TABLE IF NOT EXISTS CONSUMES_FROM(FROM ConsumerGroup TO KafkaTopic)",
	"CREATE REL TABLE IF NOT EXISTS ROUTES_TO(FROM ApiRoute TO Service)",
	"CREATE REL TABLE IF NOT EXISTS AFFECTED_BY(FROM Service TO Incident)",
	"CREATE REL TABLE IF NOT EXISTS CORRELATES_WITH(FROM Finding TO Finding, ruleName STRING, confidence DOUBLE)",
	"CREATE REL TABLE IF NOT EXISTS RESOLVED_BY(FROM Incident TO Runbook)",
	"CREATE REL TABLE IF NOT EXISTS DOCUMENTED_IN(FROM Service TO WikiPage)",
	"CREATE REL TABLE IF NOT EXISTS DEPLOYED_AS(FROM Service TO Deployment)",
	"CREATE REL TABLE IF NOT EXISTS HAS_ROOT_CAUSE(FROM Incident TO RootCause, ruleName STRING, confidence DOUBLE, createdAt STRING)",
	// SIO-954/SIO-965: IaC change-history tables. ElasticDeployment/ConfigChange
	// carry the richer SIO-965 columns (ecId/region, outcome) for FRESH graphs;
	// EXISTING graphs gain those columns via the tolerant ALTER_MIGRATIONS below
	// (CREATE ... IF NOT EXISTS no-ops on an existing table, so it cannot add them).
	"CREATE NODE TABLE IF NOT EXISTS ElasticDeployment(name STRING, ecId STRING, region STRING, PRIMARY KEY(name))",
	"CREATE NODE TABLE IF NOT EXISTS ConfigChange(id STRING, workflow STRING, filePath STRING, summary STRING, createdAt STRING, outcome STRING, PRIMARY KEY(id))",
	"CREATE NODE TABLE IF NOT EXISTS MergeRequest(url STRING, PRIMARY KEY(url))",
	"CREATE REL TABLE IF NOT EXISTS CHANGED_BY(FROM ElasticDeployment TO ConfigChange)",
	"CREATE REL TABLE IF NOT EXISTS PROPOSED_IN(FROM ConfigChange TO MergeRequest)",
	// SIO-965: three-layer IaC nodes + edges.
	"CREATE NODE TABLE IF NOT EXISTS Module(name STRING, howto STRING, PRIMARY KEY(name))",
	"CREATE NODE TABLE IF NOT EXISTS Stack(name STRING, PRIMARY KEY(name))",
	"CREATE NODE TABLE IF NOT EXISTS StackInstance(id STRING, deployment STRING, stack STRING, PRIMARY KEY(id))",
	"CREATE NODE TABLE IF NOT EXISTS Workflow(name STRING, PRIMARY KEY(name))",
	"CREATE NODE TABLE IF NOT EXISTS Session(threadId STRING, PRIMARY KEY(threadId))",
	"CREATE NODE TABLE IF NOT EXISTS Pipeline(id STRING, status STRING, url STRING, PRIMARY KEY(id))",
	// SIO-1038: verbatim per-turn user prompt. text holds the RAW, untruncated prompt.
	"CREATE NODE TABLE IF NOT EXISTS Prompt(id STRING, text STRING, agent STRING, createdAt STRING, PRIMARY KEY(id))",
	"CREATE REL TABLE IF NOT EXISTS USES_MODULE(FROM Stack TO Module)",
	"CREATE REL TABLE IF NOT EXISTS OF_STACK(FROM StackInstance TO Stack)",
	"CREATE REL TABLE IF NOT EXISTS ON_DEPLOYMENT(FROM StackInstance TO ElasticDeployment)",
	"CREATE REL TABLE IF NOT EXISTS TARGETS(FROM ConfigChange TO StackInstance)",
	"CREATE REL TABLE IF NOT EXISTS VIA_WORKFLOW(FROM ConfigChange TO Workflow)",
	"CREATE REL TABLE IF NOT EXISTS IN_SESSION(FROM ConfigChange TO Session)",
	"CREATE REL TABLE IF NOT EXISTS RAN(FROM MergeRequest TO Pipeline)",
	// SIO-1038: a turn's Prompt -> the Session (thread) it was asked in.
	"CREATE REL TABLE IF NOT EXISTS PROMPTED_IN(FROM Prompt TO Session)",
];

// SIO-965: best-effort additive column migrations for graphs created before the
// SIO-965 columns existed. Unlike MIGRATIONS these are NOT idempotent on their
// own -- a bare ALTER throws "property already exists" on re-run -- so store.init()
// runs them inside a tolerant try/catch loop (the VECTOR_INDEX_SETUP idiom). A
// future Neo4jStore skips this array entirely (Neo4j is schema-optional, no ALTER).
export const ALTER_MIGRATIONS: readonly string[] = [
	"ALTER TABLE ConfigChange ADD outcome STRING DEFAULT 'proposed'",
	"ALTER TABLE ElasticDeployment ADD ecId STRING DEFAULT ''",
	"ALTER TABLE ElasticDeployment ADD region STRING DEFAULT ''",
];

// Native vector index over Incident.embedding. Requires Ladybug's vector
// extension; creation is best-effort (the store logs and continues if the
// extension is unavailable, so the graph still works without similarity search).
export const VECTOR_INDEX_SETUP: readonly string[] = [
	"INSTALL vector",
	"LOAD vector",
	"CALL CREATE_VECTOR_INDEX('Incident', 'incident_embedding_idx', 'embedding')",
];
