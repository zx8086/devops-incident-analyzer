// src/tools/schema/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "../../config/index.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { SchemaRegistryService } from "../../services/schema-registry-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerSchemaTools(server: McpServer, service: SchemaRegistryService): void {
	const config = getConfig();

	server.tool(
		"kafka_list_schemas",
		prompts.LIST_SCHEMAS_DESCRIPTION,
		params.ListSchemasParams.shape,
		wrapHandler("kafka_list_schemas", config, async () => {
			const result = await ops.listSchemas(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_get_schema",
		prompts.GET_SCHEMA_DESCRIPTION,
		params.GetSchemaParams.shape,
		wrapHandler("kafka_get_schema", config, async (args) => {
			const result = await ops.getSchema(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_get_schema_versions",
		prompts.GET_SCHEMA_VERSIONS_DESCRIPTION,
		params.GetSchemaVersionsParams.shape,
		wrapHandler("kafka_get_schema_versions", config, async (args) => {
			const result = await ops.getSchemaVersions(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_check_compatibility",
		prompts.CHECK_COMPATIBILITY_DESCRIPTION,
		params.CheckCompatibilityParams.shape,
		wrapHandler("kafka_check_compatibility", config, async (args) => {
			const result = await ops.checkCompatibility(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_get_schema_config",
		prompts.GET_SCHEMA_CONFIG_DESCRIPTION,
		params.GetSchemaConfigParams.shape,
		wrapHandler("kafka_get_schema_config", config, async (args) => {
			const result = await ops.getSchemaConfig(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_register_schema",
		prompts.REGISTER_SCHEMA_DESCRIPTION,
		params.RegisterSchemaParams.shape,
		wrapHandler("kafka_register_schema", config, async (args) => {
			const result = await ops.registerSchema(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_set_schema_config",
		prompts.SET_SCHEMA_CONFIG_DESCRIPTION,
		params.SetSchemaConfigParams.shape,
		wrapHandler("kafka_set_schema_config", config, async (args) => {
			const result = await ops.setSchemaConfig(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_delete_schema_subject",
		prompts.DELETE_SCHEMA_SUBJECT_DESCRIPTION,
		params.DeleteSchemaSubjectParams.shape,
		wrapHandler("kafka_delete_schema_subject", config, async (args) => {
			const result = await ops.deleteSchemaSubject(service, args);
			return ResponseBuilder.success(result);
		}),
	);
}
