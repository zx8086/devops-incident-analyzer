// src/tools/schema/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { SchemaRegistryService } from "../../services/schema-registry-service.ts";
import { kafkaToolAnnotations } from "../tool-classification.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerSchemaTools(server: McpServer, service: SchemaRegistryService, config: AppConfig): void {
	// SIO-742: reachability probe -- always registered when SR is enabled.
	server.registerTool(
		"schema_registry_health_check",
		{
			description: prompts.SCHEMA_REGISTRY_HEALTH_CHECK_DESCRIPTION,
			inputSchema: params.SchemaRegistryHealthCheckParams.shape,
			annotations: kafkaToolAnnotations("schema_registry_health_check"),
		},
		wrapHandler("schema_registry_health_check", config, async () => {
			const result = await ops.healthCheck(service, config);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_list_schemas",
		{
			description: prompts.LIST_SCHEMAS_DESCRIPTION,
			inputSchema: params.ListSchemasParams.shape,
			annotations: kafkaToolAnnotations("kafka_list_schemas"),
		},
		wrapHandler("kafka_list_schemas", config, async () => {
			const result = await ops.listSchemas(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_get_schema",
		{
			description: prompts.GET_SCHEMA_DESCRIPTION,
			inputSchema: params.GetSchemaParams.shape,
			annotations: kafkaToolAnnotations("kafka_get_schema"),
		},
		wrapHandler("kafka_get_schema", config, async (args) => {
			const result = await ops.getSchema(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_get_schema_versions",
		{
			description: prompts.GET_SCHEMA_VERSIONS_DESCRIPTION,
			inputSchema: params.GetSchemaVersionsParams.shape,
			annotations: kafkaToolAnnotations("kafka_get_schema_versions"),
		},
		wrapHandler("kafka_get_schema_versions", config, async (args) => {
			const result = await ops.getSchemaVersions(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_check_compatibility",
		{
			description: prompts.CHECK_COMPATIBILITY_DESCRIPTION,
			inputSchema: params.CheckCompatibilityParams.shape,
			annotations: kafkaToolAnnotations("kafka_check_compatibility"),
		},
		wrapHandler("kafka_check_compatibility", config, async (args) => {
			const result = await ops.checkCompatibility(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_get_schema_config",
		{
			description: prompts.GET_SCHEMA_CONFIG_DESCRIPTION,
			inputSchema: params.GetSchemaConfigParams.shape,
			annotations: kafkaToolAnnotations("kafka_get_schema_config"),
		},
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
		server.registerTool(
			"kafka_register_schema",
			{
				description: prompts.REGISTER_SCHEMA_DESCRIPTION,
				inputSchema: params.RegisterSchemaParams.shape,
				annotations: kafkaToolAnnotations("kafka_register_schema"),
			},
			wrapHandler("kafka_register_schema", config, async (args) => {
				const result = await ops.registerSchema(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"kafka_set_schema_config",
			{
				description: prompts.SET_SCHEMA_CONFIG_DESCRIPTION,
				inputSchema: params.SetSchemaConfigParams.shape,
				annotations: kafkaToolAnnotations("kafka_set_schema_config"),
			},
			wrapHandler("kafka_set_schema_config", config, async (args) => {
				const result = await ops.setSchemaConfig(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}

	if (config.kafka.allowDestructive) {
		server.registerTool(
			"kafka_delete_schema_subject",
			{
				description: prompts.DELETE_SCHEMA_SUBJECT_DESCRIPTION,
				inputSchema: params.DeleteSchemaSubjectParams.shape,
				annotations: kafkaToolAnnotations("kafka_delete_schema_subject"),
			},
			wrapHandler("kafka_delete_schema_subject", config, async (args) => {
				const result = await ops.deleteSchemaSubject(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}

	// SIO-682: gated write tools
	if (config.kafka.allowWrites) {
		server.registerTool(
			"sr_register_schema",
			{
				description: prompts.SR_REGISTER_SCHEMA_DESCRIPTION,
				inputSchema: params.SrRegisterSchemaParams.shape,
				annotations: kafkaToolAnnotations("sr_register_schema"),
			},
			wrapHandler("sr_register_schema", config, async (args) => {
				const result = await ops.srRegisterSchema(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"sr_check_compatibility",
			{
				description: prompts.SR_CHECK_COMPATIBILITY_DESCRIPTION,
				inputSchema: params.SrCheckCompatibilityParams.shape,
				annotations: kafkaToolAnnotations("sr_check_compatibility"),
			},
			wrapHandler("sr_check_compatibility", config, async (args) => {
				const result = await ops.srCheckCompatibility(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"sr_set_compatibility",
			{
				description: prompts.SR_SET_COMPATIBILITY_DESCRIPTION,
				inputSchema: params.SrSetCompatibilityParams.shape,
				annotations: kafkaToolAnnotations("sr_set_compatibility"),
			},
			wrapHandler("sr_set_compatibility", config, async (args) => {
				const result = await ops.srSetCompatibility(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}

	// SIO-682: gated destructive tools
	if (config.kafka.allowDestructive) {
		server.registerTool(
			"sr_soft_delete_subject",
			{
				description: prompts.SR_SOFT_DELETE_SUBJECT_DESCRIPTION,
				inputSchema: params.SrSoftDeleteSubjectParams.shape,
				annotations: kafkaToolAnnotations("sr_soft_delete_subject"),
			},
			wrapHandler("sr_soft_delete_subject", config, async (args) => {
				const result = await ops.srSoftDeleteSubject(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"sr_soft_delete_subject_version",
			{
				description: prompts.SR_SOFT_DELETE_SUBJECT_VERSION_DESCRIPTION,
				inputSchema: params.SrSoftDeleteSubjectVersionParams.shape,
				annotations: kafkaToolAnnotations("sr_soft_delete_subject_version"),
			},
			wrapHandler("sr_soft_delete_subject_version", config, async (args) => {
				const result = await ops.srSoftDeleteSubjectVersion(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"sr_hard_delete_subject",
			{
				description: prompts.SR_HARD_DELETE_SUBJECT_DESCRIPTION,
				inputSchema: params.SrHardDeleteSubjectParams.shape,
				annotations: kafkaToolAnnotations("sr_hard_delete_subject"),
			},
			wrapHandler("sr_hard_delete_subject", config, async (args) => {
				const result = await ops.srHardDeleteSubject(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"sr_hard_delete_subject_version",
			{
				description: prompts.SR_HARD_DELETE_SUBJECT_VERSION_DESCRIPTION,
				inputSchema: params.SrHardDeleteSubjectVersionParams.shape,
				annotations: kafkaToolAnnotations("sr_hard_delete_subject_version"),
			},
			wrapHandler("sr_hard_delete_subject_version", config, async (args) => {
				const result = await ops.srHardDeleteSubjectVersion(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}
}
