// src/tools/schema/prompts.ts

export const LIST_SCHEMAS_DESCRIPTION = `[READ] List all registered schema subjects in the Schema Registry. Returns subject names which typically follow the pattern '<topic>-key' or '<topic>-value'. Use this to discover available schemas. Requires SCHEMA_REGISTRY_ENABLED=true.`;

// SIO-742: first-iteration reachability probe.
export const SCHEMA_REGISTRY_HEALTH_CHECK_DESCRIPTION =
	"[READ] Probe Schema Registry reachability. No parameters. Returns { status: 'up' | 'down' | 'unreachable', service, endpoint, latencyMs, hostname?, details?, error? }. Call this FIRST when checking whether Schema Registry is available. Do NOT infer SR state from inferred subject names returned by kafka_list_schemas when the registry REST is unreachable.";

export const GET_SCHEMA_DESCRIPTION = `[READ] Retrieve a schema by subject and version from the Schema Registry. Returns the schema definition (Avro, JSON Schema, or Protobuf), schema ID, version number, and schema type. Use 'latest' for the most recent version. Requires SCHEMA_REGISTRY_ENABLED=true.`;

export const GET_SCHEMA_VERSIONS_DESCRIPTION = `[READ] List all version numbers for a specific schema subject. Use this to understand the evolution history of a schema before retrieving a specific version. Requires SCHEMA_REGISTRY_ENABLED=true.`;

export const REGISTER_SCHEMA_DESCRIPTION = `[WRITE] Register a new schema version for a subject. Supports Avro, JSON Schema, and Protobuf schema types. The schema must be compatible with the subject's configured compatibility level. Returns the globally unique schema ID. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true and SCHEMA_REGISTRY_ENABLED=true.`;

export const CHECK_COMPATIBILITY_DESCRIPTION = `[READ] Test whether a schema is compatible with the existing schema versions for a subject. Returns compatibility status and any error messages. Use this before registering a new schema to verify it won't break consumers. Requires SCHEMA_REGISTRY_ENABLED=true.`;

export const GET_SCHEMA_CONFIG_DESCRIPTION = `[READ] Get the compatibility configuration for a subject or the global default. Compatibility levels include BACKWARD, FORWARD, FULL, BACKWARD_TRANSITIVE, FORWARD_TRANSITIVE, FULL_TRANSITIVE, and NONE. Requires SCHEMA_REGISTRY_ENABLED=true.`;

export const SET_SCHEMA_CONFIG_DESCRIPTION = `[WRITE] Set the compatibility configuration for a specific subject or the global default. Controls how new schema versions are validated against previous versions. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true and SCHEMA_REGISTRY_ENABLED=true.`;

export const DELETE_SCHEMA_SUBJECT_DESCRIPTION = `[DESTRUCTIVE] Delete a schema subject and all its versions. Soft-deletes by default; use permanent=true for hard delete. DESTRUCTIVE OPERATION: Requires KAFKA_ALLOW_DESTRUCTIVE=true and SCHEMA_REGISTRY_ENABLED=true.`;

// SIO-682: gated write/destructive prompts for sr_* tools
export const SR_REGISTER_SCHEMA_DESCRIPTION = `[WRITE] Register a new schema version for a subject in Schema Registry. Schema must pass compatibility checks for the subject's configured level. Returns the globally unique schema ID. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true.`;

export const SR_CHECK_COMPATIBILITY_DESCRIPTION = `[WRITE] Test whether a schema is compatible with existing versions for a subject. Returns compatibility status and error messages if any. Run before sr_register_schema to verify the schema won't break consumers. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true.`;

export const SR_SET_COMPATIBILITY_DESCRIPTION = `[WRITE] Set the compatibility level for a subject or global default. Controls validation of future schema versions. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true.`;

export const SR_SOFT_DELETE_SUBJECT_DESCRIPTION = `[DESTRUCTIVE] Soft-delete a subject and all its versions from Schema Registry. The subject can be recovered or hard-deleted later via sr_hard_delete_subject. Must soft-delete before hard-delete. DESTRUCTIVE OPERATION: Requires KAFKA_ALLOW_DESTRUCTIVE=true.`;

export const SR_SOFT_DELETE_SUBJECT_VERSION_DESCRIPTION = `[DESTRUCTIVE] Soft-delete a specific version of a subject. The version can be recovered or permanently removed via sr_hard_delete_subject_version. Must soft-delete before hard-delete. DESTRUCTIVE OPERATION: Requires KAFKA_ALLOW_DESTRUCTIVE=true.`;

export const SR_HARD_DELETE_SUBJECT_DESCRIPTION = `[DESTRUCTIVE] Permanently delete a subject from Schema Registry. Requires prior soft-delete via sr_soft_delete_subject; this tool will not auto-sequence. Returns 404 if not first soft-deleted. Irreversible. DESTRUCTIVE OPERATION: Requires KAFKA_ALLOW_DESTRUCTIVE=true.`;

export const SR_HARD_DELETE_SUBJECT_VERSION_DESCRIPTION = `[DESTRUCTIVE] Permanently delete a specific version of a subject. Requires prior soft-delete via sr_soft_delete_subject_version; this tool will not auto-sequence. Returns 404 if not first soft-deleted. Irreversible. DESTRUCTIVE OPERATION: Requires KAFKA_ALLOW_DESTRUCTIVE=true.`;
