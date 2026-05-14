// src/tools/wrap.ts
import type { AppConfig } from "../config/schemas.ts";
import { KafkaToolError, normalizeError } from "../lib/errors.ts";
import { ResponseBuilder } from "../lib/response-builder.ts";
import { logger } from "../utils/logger.ts";
import { traceToolCall } from "../utils/tracing.ts";

type ToolResponse = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

const WRITE_TOOLS = new Set([
	"kafka_produce_message",
	"kafka_create_topic",
	"kafka_alter_topic_config",
	"kafka_register_schema",
	"kafka_set_schema_config",
	"ksql_execute_statement",
]);

const DESTRUCTIVE_TOOLS = new Set([
	"kafka_delete_topic",
	"kafka_reset_consumer_group_offsets",
	"kafka_delete_schema_subject",
]);

const SCHEMA_REGISTRY_TOOLS = new Set([
	"kafka_list_schemas",
	"kafka_get_schema",
	"kafka_get_schema_versions",
	"kafka_register_schema",
	"kafka_check_compatibility",
	"kafka_get_schema_config",
	"kafka_set_schema_config",
	"kafka_delete_schema_subject",
	"schema_registry_health_check",
]);

const KSQL_TOOLS = new Set([
	"ksql_get_server_info",
	"ksql_health_check",
	"ksql_cluster_status",
	"ksql_list_streams",
	"ksql_list_tables",
	"ksql_list_queries",
	"ksql_describe",
	"ksql_run_query",
	"ksql_execute_statement",
]);

export function wrapHandler<T>(
	toolName: string,
	config: AppConfig,
	handler: (args: T) => Promise<ToolResponse>,
): (args: T) => Promise<ToolResponse> {
	return async (args: T) => {
		if (SCHEMA_REGISTRY_TOOLS.has(toolName) && !config.schemaRegistry.enabled) {
			return ResponseBuilder.error(
				"Schema Registry is not enabled. Set SCHEMA_REGISTRY_ENABLED=true and SCHEMA_REGISTRY_URL to enable.",
			);
		}

		if (KSQL_TOOLS.has(toolName) && !config.ksql.enabled) {
			return ResponseBuilder.error("ksqlDB is not enabled. Set KSQL_ENABLED=true and KSQL_ENDPOINT to enable.");
		}

		if (WRITE_TOOLS.has(toolName) && !config.kafka.allowWrites) {
			return ResponseBuilder.error("Write operations are disabled. Set KAFKA_ALLOW_WRITES=true to enable.");
		}
		if (DESTRUCTIVE_TOOLS.has(toolName) && !config.kafka.allowDestructive) {
			return ResponseBuilder.error("Destructive operations are disabled. Set KAFKA_ALLOW_DESTRUCTIVE=true to enable.");
		}

		return traceToolCall(toolName, async () => {
			try {
				return await handler(args);
			} catch (error) {
				const mcpError = normalizeError(error);
				// SIO-728: when the original error is a KafkaToolError carrying upstream
				// metadata (populated by fetchUpstream in SIO-725/729), forward it through
				// the ---STRUCTURED--- sentinel so the agent can lift it into a ToolError.
				const structured = error instanceof KafkaToolError ? extractStructuredFields(error) : undefined;
				logger.error({ tool: toolName, error: mcpError.message, ...structured }, "Tool call error");
				return ResponseBuilder.error(mcpError.message, structured);
			}
		});
	};
}

// SIO-728: lift the upstream-metadata fields off a KafkaToolError into the
// JSON-serialisable shape the sentinel carries. Returns undefined when no
// upstream metadata is present (preserves byte-identical ResponseBuilder output
// for validation / config errors that have no hostname).
function extractStructuredFields(err: KafkaToolError): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	if (err.hostname !== undefined) out.hostname = err.hostname;
	if (err.upstreamContentType !== undefined) out.upstreamContentType = err.upstreamContentType;
	if (err.statusCode !== undefined) out.statusCode = err.statusCode;
	return Object.keys(out).length === 0 ? undefined : out;
}
