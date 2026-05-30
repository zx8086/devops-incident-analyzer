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
export type ServiceNode = z.infer<typeof ServiceNodeSchema>;
export type IncidentNode = z.infer<typeof IncidentNodeSchema>;
export type FindingNode = z.infer<typeof FindingNodeSchema>;

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
	"CREATE REL TABLE IF NOT EXISTS DEPENDS_ON(FROM Service TO Service)",
	"CREATE REL TABLE IF NOT EXISTS PRODUCES_TO(FROM Service TO KafkaTopic)",
	"CREATE REL TABLE IF NOT EXISTS CONSUMES_FROM(FROM ConsumerGroup TO KafkaTopic)",
	"CREATE REL TABLE IF NOT EXISTS ROUTES_TO(FROM ApiRoute TO Service)",
	"CREATE REL TABLE IF NOT EXISTS AFFECTED_BY(FROM Service TO Incident)",
	"CREATE REL TABLE IF NOT EXISTS CORRELATES_WITH(FROM Finding TO Finding, ruleName STRING, confidence DOUBLE)",
	"CREATE REL TABLE IF NOT EXISTS RESOLVED_BY(FROM Incident TO Runbook)",
	"CREATE REL TABLE IF NOT EXISTS DOCUMENTED_IN(FROM Service TO WikiPage)",
	"CREATE REL TABLE IF NOT EXISTS DEPLOYED_AS(FROM Service TO Deployment)",
];

// Native vector index over Incident.embedding. Requires Ladybug's vector
// extension; creation is best-effort (the store logs and continues if the
// extension is unavailable, so the graph still works without similarity search).
export const VECTOR_INDEX_SETUP: readonly string[] = [
	"INSTALL vector",
	"LOAD vector",
	"CALL CREATE_VECTOR_INDEX('Incident', 'incident_embedding_idx', 'embedding')",
];
