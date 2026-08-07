// src/tools/connect/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { ConnectService } from "../../services/connect-service.ts";
import { kafkaToolAnnotations } from "../tool-classification.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerConnectTools(server: McpServer, service: ConnectService, config: AppConfig): void {
	// SIO-742: reachability probe -- always registered.
	server.registerTool(
		"connect_health_check",
		{
			description: prompts.CONNECT_HEALTH_CHECK_DESCRIPTION,
			inputSchema: params.ConnectHealthCheckParams.shape,
			annotations: kafkaToolAnnotations("connect_health_check"),
		},
		wrapHandler("connect_health_check", config, async () => {
			const result = await ops.healthCheck(service, config);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"connect_get_cluster_info",
		{
			description: prompts.CONNECT_GET_CLUSTER_INFO_DESCRIPTION,
			inputSchema: params.ConnectGetClusterInfoParams.shape,
			annotations: kafkaToolAnnotations("connect_get_cluster_info"),
		},
		wrapHandler("connect_get_cluster_info", config, async () => {
			const result = await ops.getClusterInfo(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"connect_list_connectors",
		{
			description: prompts.CONNECT_LIST_CONNECTORS_DESCRIPTION,
			inputSchema: params.ConnectListConnectorsParams.shape,
			annotations: kafkaToolAnnotations("connect_list_connectors"),
		},
		wrapHandler("connect_list_connectors", config, async () => {
			const result = await ops.listConnectors(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"connect_get_connector_status",
		{
			description: prompts.CONNECT_GET_CONNECTOR_STATUS_DESCRIPTION,
			inputSchema: params.ConnectGetConnectorStatusParams.shape,
			annotations: kafkaToolAnnotations("connect_get_connector_status"),
		},
		wrapHandler("connect_get_connector_status", config, async (args) => {
			const result = await ops.getConnectorStatus(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"connect_get_connector_task_status",
		{
			description: prompts.CONNECT_GET_CONNECTOR_TASK_STATUS_DESCRIPTION,
			inputSchema: params.ConnectGetConnectorTaskStatusParams.shape,
			annotations: kafkaToolAnnotations("connect_get_connector_task_status"),
		},
		wrapHandler("connect_get_connector_task_status", config, async (args) => {
			const result = await ops.getConnectorTaskStatus(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	if (config.kafka.allowWrites) {
		server.registerTool(
			"connect_pause_connector",
			{
				description: prompts.CONNECT_PAUSE_CONNECTOR_DESCRIPTION,
				inputSchema: params.ConnectPauseConnectorParams.shape,
				annotations: kafkaToolAnnotations("connect_pause_connector"),
			},
			wrapHandler("connect_pause_connector", config, async (args) => {
				const result = await ops.pauseConnector(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"connect_resume_connector",
			{
				description: prompts.CONNECT_RESUME_CONNECTOR_DESCRIPTION,
				inputSchema: params.ConnectResumeConnectorParams.shape,
				annotations: kafkaToolAnnotations("connect_resume_connector"),
			},
			wrapHandler("connect_resume_connector", config, async (args) => {
				const result = await ops.resumeConnector(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"connect_restart_connector",
			{
				description: prompts.CONNECT_RESTART_CONNECTOR_DESCRIPTION,
				inputSchema: params.ConnectRestartConnectorParams.shape,
				annotations: kafkaToolAnnotations("connect_restart_connector"),
			},
			wrapHandler("connect_restart_connector", config, async (args) => {
				const result = await ops.restartConnector(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}

	if (config.kafka.allowDestructive) {
		server.registerTool(
			"connect_restart_connector_task",
			{
				description: prompts.CONNECT_RESTART_CONNECTOR_TASK_DESCRIPTION,
				inputSchema: params.ConnectRestartConnectorTaskParams.shape,
				annotations: kafkaToolAnnotations("connect_restart_connector_task"),
			},
			wrapHandler("connect_restart_connector_task", config, async (args) => {
				const result = await ops.restartConnectorTask(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"connect_delete_connector",
			{
				description: prompts.CONNECT_DELETE_CONNECTOR_DESCRIPTION,
				inputSchema: params.ConnectDeleteConnectorParams.shape,
				annotations: kafkaToolAnnotations("connect_delete_connector"),
			},
			wrapHandler("connect_delete_connector", config, async (args) => {
				const result = await ops.deleteConnector(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}
}
