// src/tools/schema/prompts.ts

export const LIST_SCHEMAS_DESCRIPTION = `List all registered schema subjects in the Schema Registry. Returns subject names which typically follow the pattern '<topic>-key' or '<topic>-value'. Use this to discover available schemas. Requires SCHEMA_REGISTRY_ENABLED=true.`;

export const GET_SCHEMA_DESCRIPTION = `Retrieve a schema by subject and version from the Schema Registry. Returns the schema definition (Avro, JSON Schema, or Protobuf), schema ID, version number, and schema type. Use 'latest' for the most recent version. Requires SCHEMA_REGISTRY_ENABLED=true.`;

export const GET_SCHEMA_VERSIONS_DESCRIPTION = `List all version numbers for a specific schema subject. Use this to understand the evolution history of a schema before retrieving a specific version. Requires SCHEMA_REGISTRY_ENABLED=true.`;

export const REGISTER_SCHEMA_DESCRIPTION = `Register a new schema version for a subject. Supports Avro, JSON Schema, and Protobuf schema types. The schema must be compatible with the subject's configured compatibility level. Returns the globally unique schema ID. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true and SCHEMA_REGISTRY_ENABLED=true.`;

export const CHECK_COMPATIBILITY_DESCRIPTION = `Test whether a schema is compatible with the existing schema versions for a subject. Returns compatibility status and any error messages. Use this before registering a new schema to verify it won't break consumers. Requires SCHEMA_REGISTRY_ENABLED=true.`;

export const GET_SCHEMA_CONFIG_DESCRIPTION = `Get the compatibility configuration for a subject or the global default. Compatibility levels include BACKWARD, FORWARD, FULL, BACKWARD_TRANSITIVE, FORWARD_TRANSITIVE, FULL_TRANSITIVE, and NONE. Requires SCHEMA_REGISTRY_ENABLED=true.`;

export const SET_SCHEMA_CONFIG_DESCRIPTION = `Set the compatibility configuration for a specific subject or the global default. Controls how new schema versions are validated against previous versions. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true and SCHEMA_REGISTRY_ENABLED=true.`;

export const DELETE_SCHEMA_SUBJECT_DESCRIPTION = `Delete a schema subject and all its versions. Soft-deletes by default; use permanent=true for hard delete. DESTRUCTIVE OPERATION: Requires KAFKA_ALLOW_DESTRUCTIVE=true and SCHEMA_REGISTRY_ENABLED=true.`;
