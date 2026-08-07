// src/tools/tool-classification.ts
// SIO-1421: annotation classification for every tool this server registers. The
// kafka-core classification is a pure lookup into wrap.ts's own WRITE_TOOLS/
// DESTRUCTIVE_TOOLS enforcement Sets (per the ticket; the read/ write/
// destructive/ directory convention mirrors it). Those Sets predate the gated
// connect/restproxy/sr_* sub-surfaces, so this module EXTENDS them for
// annotation purposes only -- wrap.ts's runtime write-gate enforcement is
// deliberately untouched (changing it is enforcement policy, not annotation;
// see the SIO-1186 kafka audit for that discussion).
import { deriveToolAnnotations } from "@devops-agent/shared";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { DESTRUCTIVE_TOOLS, WRITE_TOOLS } from "./wrap.ts";

// Gated sub-surface writes absent from wrap.ts's core Sets, hand-reviewed:
// producers and registrations are additive; subscribe/commit mutate only the
// caller's own consumer-instance state; connector pause/resume/restart are
// reversible operational state changes (no config or data loss).
const EXTENDED_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"sr_register_schema",
	"sr_set_compatibility",
	"restproxy_produce",
	"restproxy_create_consumer",
	"restproxy_subscribe",
	"restproxy_commit_offsets",
	"connect_pause_connector",
	"connect_resume_connector",
	"connect_restart_connector",
	"connect_restart_connector_task",
]);

// Gated sub-surface deletes: non-additive per the spec's semantics.
const EXTENDED_DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
	"sr_soft_delete_subject",
	"sr_soft_delete_subject_version",
	"sr_hard_delete_subject",
	"sr_hard_delete_subject_version",
	"connect_delete_connector",
	"restproxy_delete_consumer",
]);

// Everything else is read-only: kafka-core reads (read/ directory), schema/ksql/
// connect/restproxy health checks + lookups, ksql_run_query (pull query), and
// consume paths (kafka_consume_messages / restproxy_consume read messages
// without committing offsets).
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"kafka_list_topics",
	"kafka_describe_topic",
	"kafka_get_topic_offsets",
	"kafka_consume_messages",
	"kafka_list_consumer_groups",
	"kafka_list_dlq_topics",
	"kafka_describe_consumer_group",
	"kafka_get_cluster_info",
	"kafka_get_consumer_group_lag",
	"kafka_describe_cluster",
	"kafka_get_message_by_offset",
	"schema_registry_health_check",
	"kafka_list_schemas",
	"kafka_get_schema",
	"kafka_get_schema_versions",
	"kafka_check_compatibility",
	"kafka_get_schema_config",
	"sr_check_compatibility",
	"ksql_health_check",
	"ksql_cluster_status",
	"ksql_get_server_info",
	"ksql_list_streams",
	"ksql_list_tables",
	"ksql_list_queries",
	"ksql_describe",
	"ksql_run_query",
	"connect_health_check",
	"connect_get_cluster_info",
	"connect_list_connectors",
	"connect_get_connector_status",
	"connect_get_connector_task_status",
	"restproxy_health_check",
	"restproxy_list_topics",
	"restproxy_get_topic",
	"restproxy_get_partitions",
	"restproxy_consume",
]);

const ALL_WRITE: ReadonlySet<string> = new Set([
	...WRITE_TOOLS,
	...EXTENDED_WRITE_TOOLS,
	...DESTRUCTIVE_TOOLS,
	...EXTENDED_DESTRUCTIVE_TOOLS,
]);
const ALL_DESTRUCTIVE: ReadonlySet<string> = new Set([...DESTRUCTIVE_TOOLS, ...EXTENDED_DESTRUCTIVE_TOOLS]);

// Classification-integrity check, fail-fast at module load.
for (const name of READ_ONLY_TOOLS) {
	if (ALL_WRITE.has(name)) throw new Error(`SIO-1421: "${name}" classified both read-only and write.`);
}

// Throws on an unclassified name, so a new tool cannot register without a
// recorded read/write decision (the konnect C-1 guard, explicit-Sets form).
export function kafkaToolAnnotations(name: string): ToolAnnotations | undefined {
	if (!READ_ONLY_TOOLS.has(name) && !ALL_WRITE.has(name)) {
		throw new Error(
			`SIO-1421: tool "${name}" has no read/write classification -- add it to tool-classification.ts before registering.`,
		);
	}
	return deriveToolAnnotations(name, { readOnly: READ_ONLY_TOOLS, destructive: ALL_DESTRUCTIVE });
}
