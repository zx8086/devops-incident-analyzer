// src/tools/wrap.ts
import type { AppConfig } from "../config/schemas.ts";
import { normalizeError } from "../lib/errors.ts";
import { ResponseBuilder } from "../lib/response-builder.ts";
import { getLogger } from "../logging/container.ts";
import { traceToolExecution } from "../telemetry/tracing.ts";

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
]);

const KSQL_TOOLS = new Set([
	"ksql_get_server_info",
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
		const logger = getLogger();

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

		return traceToolExecution(toolName, async () => {
			const startTime = Date.now();
			try {
				logger.debug(`Executing tool: ${toolName}`, {
					args: Object.keys(args as Record<string, unknown>),
				});
				const result = await handler(args);
				const duration = Date.now() - startTime;
				logger.debug(`Tool completed: ${toolName}`, { duration });
				return result;
			} catch (error) {
				const duration = Date.now() - startTime;
				logger.error(`Tool failed: ${toolName}`, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					duration,
				});
				const mcpError = normalizeError(error);
				return ResponseBuilder.error(mcpError.message);
			}
		});
	};
}
