// src/tools/schema/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { SchemaRegistryService } from "../../services/schema-registry-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerSchemaTools(server: McpServer, service: SchemaRegistryService, config: AppConfig): void {
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

	// SIO-732: gate kafka_register_schema and kafka_set_schema_config at
	// registration time (writes) and kafka_delete_schema_subject (destructive),
	// matching the sr_* gating block below. The wrap-layer checks in tools/wrap.ts
	// remain as belt-and-braces.
	if (config.kafka.allowWrites) {
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
	}

	if (config.kafka.allowDestructive) {
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

	// SIO-682: gated write tools
	if (config.kafka.allowWrites) {
		server.tool(
			"sr_register_schema",
			prompts.SR_REGISTER_SCHEMA_DESCRIPTION,
			params.SrRegisterSchemaParams.shape,
			wrapHandler("sr_register_schema", config, async (args) => {
				const result = await ops.srRegisterSchema(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"sr_check_compatibility",
			prompts.SR_CHECK_COMPATIBILITY_DESCRIPTION,
			params.SrCheckCompatibilityParams.shape,
			wrapHandler("sr_check_compatibility", config, async (args) => {
				const result = await ops.srCheckCompatibility(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"sr_set_compatibility",
			prompts.SR_SET_COMPATIBILITY_DESCRIPTION,
			params.SrSetCompatibilityParams.shape,
			wrapHandler("sr_set_compatibility", config, async (args) => {
				const result = await ops.srSetCompatibility(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}

	// SIO-682: gated destructive tools
	if (config.kafka.allowDestructive) {
		server.tool(
			"sr_soft_delete_subject",
			prompts.SR_SOFT_DELETE_SUBJECT_DESCRIPTION,
			params.SrSoftDeleteSubjectParams.shape,
			wrapHandler("sr_soft_delete_subject", config, async (args) => {
				const result = await ops.srSoftDeleteSubject(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"sr_soft_delete_subject_version",
			prompts.SR_SOFT_DELETE_SUBJECT_VERSION_DESCRIPTION,
			params.SrSoftDeleteSubjectVersionParams.shape,
			wrapHandler("sr_soft_delete_subject_version", config, async (args) => {
				const result = await ops.srSoftDeleteSubjectVersion(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"sr_hard_delete_subject",
			prompts.SR_HARD_DELETE_SUBJECT_DESCRIPTION,
			params.SrHardDeleteSubjectParams.shape,
			wrapHandler("sr_hard_delete_subject", config, async (args) => {
				const result = await ops.srHardDeleteSubject(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"sr_hard_delete_subject_version",
			prompts.SR_HARD_DELETE_SUBJECT_VERSION_DESCRIPTION,
			params.SrHardDeleteSubjectVersionParams.shape,
			wrapHandler("sr_hard_delete_subject_version", config, async (args) => {
				const result = await ops.srHardDeleteSubjectVersion(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}
}
